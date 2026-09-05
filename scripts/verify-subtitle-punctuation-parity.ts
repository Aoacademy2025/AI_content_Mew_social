import assert from 'node:assert/strict';
import {cardsByWordCount} from '../src/lib/mcp/orchestrator-steps';
import {regroupCaptions} from '../src/app/(dashboard)/video-editor/_v2/subtitle-style';
const text='มิวถามว่า ดีขึ้นไหม?\nเวลา 08:30 น. อ่านช้า ๆ แล้วไป';
const tokens=['มิว','ถาม','ว่า','ดี','ขึ้น','ไหม','เวลา','08','30','น','อ่าน','ช้า','ๆ','แล้ว','ไป'];
let cursor=0;
const words=tokens.map((word,i)=>{const startChar=text.indexOf(word,cursor);cursor=startChar+word.length;return {word,startChar,endChar:cursor,startMs:i*300,endMs:(i+1)*300};});
for(const n of [1,2,3,4]) {
 const server=cardsByWordCount(words,n,text);
 const client=regroupCaptions([],String(n) as '1'|'2'|'3'|'4',words,text);
 assert.equal(server.map(c=>c.text).join('').replace(/\s/g,''),text.replace(/\s/g,''),`server mode ${n} preserves every punctuation mark`);
 assert.deepEqual(client.map(({tag,...card})=>card),server,`client/server mode ${n} agree on text and timing`);
 assert.ok(server.every(c=>!c.text.startsWith('ๆ')),`mode ${n} never orphans repetition mark`);
 assert.ok(server.some(c=>c.text.includes('08:30')),`mode ${n} keeps a clock time intact`);
}
console.log('PASS: word-card modes preserve punctuation, time and repetition marks with client/server parity');
