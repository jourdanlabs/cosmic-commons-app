// Copyright 2026 Leland Jourdan II / C&L Strategy
// SPDX-License-Identifier: Apache-2.0
import { assertEngine } from './integrity.mjs';
process.once('message', async message => {
  try {
    assertEngine();
    const core=await import('../vendor/commons/dist/src/index.js');
    let result;
    if(message.operation==='run') result=core.runRequest(core.parseStrictJson(message.raw));
    else if(message.operation==='verify') result=core.verifyRunText(message.raw,message.expected);
    else if(message.operation==='runtime') result=core.executionRuntime();
    else throw new Error('Unsupported worker operation');
    process.send({ok:true,result},()=>process.disconnect());
  } catch(error) {process.send({ok:false,error:error.message,code:error.code??'ENGINE_REFUSAL'},()=>process.disconnect());}
});
