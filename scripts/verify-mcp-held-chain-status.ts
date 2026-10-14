/* eslint-disable @typescript-eslint/no-explicit-any -- transport registration fixture retains real callbacks and database behavior */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
process.env.DATABASE_URL = `file:${join(mkdtempSync(join(tmpdir(), 'final-status-probe-')), 'test.db')}`;
process.env.MINUTE_QUOTA = '1';
process.env.CREDITS_LIVE = '1';
process.env.MCP_EDITOR_PROJECT_PUBLIC = '1';
globalThis.fetch = async () => { throw Error('Network forbidden'); };
execFileSync('./node_modules/.bin/prisma', ['db', 'push', '--skip-generate'], { env: process.env, stdio: 'pipe' });
async function main() {
    const { prisma } = await import('../src/lib/prisma');
    const { prepareVideoQuote, decideVideoQuote } = await import('../src/lib/mcp/video-quote.server');
    const { consumeVideoQuote } = await import('../src/lib/mcp/video-budget.server');
    const { holdVideoBudget } = await import('../src/lib/mcp/video-budget-checkpoint');
    const { VideoBudgetHoldError } = await import('../src/lib/mcp/video-budget-admission');
    try {
        const owner = await prisma.user.create({ data: { name: 'Probe', email: 'probe@example.test', role: 'USER', plan: 'PRO', planExpiresAt: new Date(Date.now() + 86400000), minutesLimit: 100, usagePeriodStartedAt: new Date() } });
        await prisma.payment.create({ data: { userId: owner.id, stripeSessionId: 'probe-paid', plan: 'PRO', amount: 100, status: 'PAID', paidAt: new Date() } });
        await prisma.creditBalance.create({ data: { userId: owner.id, purchased: 100 } });
        const registered = new Map<string, (...args: any[]) => any>();
        const descriptions = new Map<string, string>();
        const requireLocal = createRequire(import.meta.url);
        const routeModule = { exports: {} };
        const routeRequire = (specifier: string) => {
            if (specifier === 'mcp-handler')
                return { createMcpHandler: (register: (...args: any[]) => any) => { register({ server: { _requestHandlers: new Map([['tools/call', () => undefined]]) }, setToolRequestHandlers: () => undefined, registerTool: (name: string, _definition: unknown, callback: (...args: any[]) => any) => { registered.set(name, callback); descriptions.set(name, (_definition as {
                            description: string;
                        }).description); } }); return async () => new Response(); }, withMcpAuth: (handler: unknown) => handler };
            if (specifier === '@clerk/nextjs/server')
                return { auth: async () => { throw Error('No Clerk'); } };
            if (specifier === '@clerk/mcp-tools/next')
                return { verifyClerkToken: async () => undefined };
            return requireLocal(specifier.startsWith('@/') ? join(process.cwd(), 'src', specifier.slice(2)) : specifier);
        };
        const compiled = ts.transpileModule(readFileSync('src/app/api/[transport]/route.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
        new Function('require', 'module', 'exports', compiled)(routeRequire, routeModule, routeModule.exports);
        for (const required of ['stock', 'hero-ai-image', 'automix', 'external', 'prepare_video_job', 'confirmationUrl', 'quoteId', 'clipUploadId'])
            assert(descriptions.get('create_video_job')?.includes(required));
        const callTool = async (name: string, args: unknown, user = owner) => JSON.parse((await registered.get(name)!(args, { authInfo: { extra: { userId: user.id, user, effectivePlan: 'PRO' } } })).content[0].text);
        const call = (id: string) => callTool('get_video_status', { id });
        const foreign = await prisma.user.create({ data: { name: 'Other', email: 'other@example.test', role: 'USER', plan: 'PRO' } });
        const { createVideoJob, recoverProcessingJobsAfterWorkerRestart } = await import('../src/lib/mcp/video-job');
        for (const exportMode of ['auto', 'hold'] as const) {
            const quote = await prepareVideoQuote(owner, { script: 'A retained narration.', brollSource: 'stock', exportMode });
            assert('quoteId' in quote);
            await decideVideoQuote(owner.id, quote.quoteId, 'approve');
            const created = await consumeVideoQuote(owner.id, quote.quoteId);
            assert('jobId' in created, JSON.stringify(created));
            const incremental = await holdVideoBudget(owner.id, created.jobId, new VideoBudgetHoldError('render_ceiling', { renderMinutes: 1 }));
            assert(incremental);
            const direct = await call(created.jobId);
            assert.equal(direct.quote.quoteId, incremental);
            assert(direct.quote.confirmationUrl);
            console.log('PASS actual registered callback exposes direct root approval hold', exportMode);
            await decideVideoQuote(owner.id, incremental, 'approve');
            assert('jobId' in await consumeVideoQuote(owner.id, incremental));
            // Seed completed preview, then actual inherited export identity and durable interrupted submission.
            await prisma.videoJob.update({ where: { id: created.jobId }, data: { status: 'done', outputJson: JSON.stringify({ videoUrl: '/api/renders/fixture.mp4', preview: { config: { durationInFrames: 150, bgVideos: [] }, captions: [] } }) } });
            const child = await createVideoJob(owner.id, { mode: 'export', sourceJobId: created.jobId, ...(exportMode === 'hold' ? { mcpRootJobId: created.jobId } : { mcpChainExport: true }) }, exportMode === 'auto' ? `mcp-chain:${created.jobId}` : `mcp-export:${created.jobId}:1`, { type: 'export', projectId: created.projectId });
            await prisma.videoJob.update({ where: { id: child.id }, data: { status: 'processing', currentStep: 'burn', budgetCheckpointJson: JSON.stringify({ version: 1, calls: { interrupted: { path: '/api/videos/render', state: 'running' } } }) } });
            await prisma.editorProject.update({ where: { id: created.projectId }, data: { activeExportJobId: child.id } });
            await recoverProcessingJobsAfterWorkerRestart();
            const after = await prisma.videoJob.findUniqueOrThrow({ where: { id: child.id } });
            assert.equal(after.status, 'confirmation_required');
            const directChild = await call(child.id);
            const viaRoot = await call(created.jobId);
            assert.equal(directChild.status, 'confirmation_required');
            assert(directChild.next);
            console.log(JSON.stringify({ exportMode, actualChild: after.status, directChild: directChild.status, rootStatus: viaRoot.status, rootNext: viaRoot.next, rootRetainedCheckpoint: viaRoot.retainedCheckpoint }));
            assert.equal(viaRoot.status, 'confirmation_required');
            assert(viaRoot.next);
            assert.equal(viaRoot.retainedCheckpoint, true);
            assert.equal(viaRoot.quote, undefined);
            assert.equal(viaRoot.heldJobId, child.id);
            const unavailable = await prepareVideoQuote(owner, { resumeJobId: child.id });
            assert.equal((unavailable as {
                code?: string;
            }).code, 'resume_unavailable');
            const foreignStatus = await callTool('get_video_status', { id: created.jobId }, foreign);
            assert.equal(foreignStatus.found, false);
            assert.equal(foreignStatus.retainedCheckpoint, undefined);
            const foreignBurn = await prisma.renderJob.create({ data: { userId: foreign.id, parentJobId: child.id, type: 'BURN', status: 'DONE', payload: '{}', videoUrl: '/api/renders/foreign.mp4' } });
            const wrongType = await prisma.renderJob.create({ data: { userId: owner.id, parentJobId: child.id, type: 'RENDER', status: 'DONE', payload: '{}', videoUrl: '/api/renders/wrong-type.mp4' } });
            const stillUnavailable = await callTool('prepare_video_job', { resumeJobId: child.id });
            assert.equal(stillUnavailable.code, 'resume_unavailable');
            await prisma.renderJob.deleteMany({ where: { id: { in: [foreignBurn.id, wrongType.id] } } });
            const quotesBefore = await prisma.mcpVideoQuote.count();
            const ledgerBefore = await prisma.creditLedger.count();
            const late = await prisma.renderJob.create({ data: { userId: owner.id, parentJobId: child.id, type: 'BURN', status: 'DONE', payload: '{}', videoUrl: '/api/renders/late-known-burn.mp4' } });
            const resume = await callTool('prepare_video_job', { resumeJobId: child.id });
            assert('quoteId' in resume, JSON.stringify(resume));
            const resumed = await prisma.videoJob.findUniqueOrThrow({ where: { id: child.id } });
            assert.equal(resumed.status, 'queued');
            assert.equal(resumed.budgetQuoteId, quote.quoteId);
            assert.equal(await prisma.mcpVideoQuote.count(), quotesBefore);
            assert.equal(await prisma.creditLedger.count(), ledgerBefore);
            const { checkpointedBudgetCaller } = await import('../src/lib/mcp/video-budget-checkpoint');
            const retained = checkpointedBudgetCaller(owner.id, child.id, { post: async () => { throw Error('Duplicate paid call'); }, get: async () => { throw Error('Unexpected GET'); }, patch: async () => { throw Error('Unexpected PATCH'); } });
            assert.deepEqual(await retained.post('/api/videos/render', { subtitleOverlayConfig: { videoUrl: '/api/renders/fixture.mp4' } }), { jobId: late.id });
            console.log('PASS known late BURN resumes same child without new approval, ledger entry or provider call', exportMode);
        }
        console.log('PASS public root polls preserve export child uncertainty after restart recovery');
    }
    finally {
        await prisma.$disconnect();
    }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
