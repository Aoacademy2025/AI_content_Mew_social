import assert from 'node:assert/strict';
import {snapCardsToWordBoundaries,splitSentenceCards} from '../src/lib/tts-timing';
const text='และพักสักนิด เรื่องเล็ก ๆ ก็ช่วยให้งานดีขึ้นได้';
for(const limit of [20,21,22,23,24,30]){
 const cards=snapCardsToWordBoundaries(splitSentenceCards(text,limit),text);
 assert.equal(cards.map(c=>text.slice(c.startChar,c.endChar)).join(''),text);
 assert.ok(cards.every(c=>!text.slice(c.startChar,c.endChar).trimStart().startsWith('ๆ')),`sentence limit ${limit} must not orphan ๆ: ${JSON.stringify(cards.map(c=>text.slice(c.startChar,c.endChar)))}`);
}
const edge=text.indexOf(' ๆ');
const snapped=snapCardsToWordBoundaries([{startChar:0,endChar:edge},{startChar:edge,endChar:text.length}],text);
assert.ok(snapped.every(c=>!text.slice(c.startChar,c.endChar).trimStart().startsWith('ๆ')),'LLM card boundaries must keep the repetition mark with its word');
console.log('PASS: sentence and LLM card boundaries keep repetition marks attached');
