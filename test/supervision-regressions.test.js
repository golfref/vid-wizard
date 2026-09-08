import test from 'node:test';
import assert from 'node:assert/strict';
import { canAssemble, assembleApprovedShots } from '../poc/src/review-service.js';
import * as core from '../poc/src/core.js';
const review = {usable:true,identityMappingPass:true,backgroundPreserved:true,motionPreserved:true,flickerAcceptable:true,seamAcceptable:null,failureReasons:[],notes:'reviewed'};
const record = id => ({shotId:id,status:'success',outputVideoUrl:'https://example.com/video.mp4',qualityReview:review});
test('assembly accepts shuffled complete records but rejects missing and duplicate membership',()=>{
 assert.equal(canAssemble([record('b'),record('a')],{expectedShotIds:['a','b']}),true);
 assert.throws(()=>canAssemble([record('a')],{expectedShotIds:['a','b']}));
 assert.throws(()=>canAssemble([record('a'),record('a')],{expectedShotIds:['a','b']}));
});
test('assembly rejects absent source interval rather than letting NaN pass',async()=>{
 await assert.rejects(()=>assembleApprovedShots({records:[{...record('a'),generationId:'g',templateId:'t'}],expectedShotIds:['a'],planSnapshot:{shots:[{id:'a',startSeconds:0,endSeconds:1}]},generationId:'g',templateId:'t',normalize:true,probe:async()=>{},tempDirectory:'/tmp/unused',download:async()=>{throw Error('download reached')}}),/source interval/);
});
test('template cost per usable includes unsuccessful generations and requires complete costs',()=>{
 assert.equal(typeof core.buildTemplateReport,'function');
 const generations=[{generationId:'g1',templateId:'t',mode:'live'},{generationId:'g2',templateId:'t',mode:'live'}];
 const shots=[{generationId:'g1',status:'success',costUsd:2,creditsConsumed:20},{generationId:'g2',status:'fail',costUsd:1,creditsConsumed:10}];
 const finals=[{generationId:'g1',finalReview:{usable:true}}];
 assert.equal(core.buildTemplateReport(generations,shots,finals)[0].costPerUsableFinalUsd,3);
 shots[1].costUsd=null;
 assert.equal(core.buildTemplateReport(generations,shots,finals)[0].costPerUsableFinalUsd,null);
});
