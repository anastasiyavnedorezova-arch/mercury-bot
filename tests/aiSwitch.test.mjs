import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { switchAI, updateProviders, selectProviders } from '../tools/ai-switch/core.mjs';
import { probeAI, sampleImage } from '../tools/ai-switch/probe.mjs';
const original='OPENAI_API_KEY=private\nTELEGRAM_API_BASE_URL=https://relay.example/telegram\nOPENAI_BASE_URL=https://relay.example/openai/v1\nAI_TEXT_PROVIDER=openai\nAI_STATEMENT_PROVIDER=openai\nAI_VOICE_PROVIDER=openai\n';
async function fixture(fn) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'finnik-ai-switch-test-'));
  const envPath=path.join(dir,'env'),stateDir=path.join(dir,'state');
  await fs.writeFile(envPath,original,{mode:0o600});
  const options={envPath,stateDir,provider:'yandex',parse,probe:async()=>{},restart:async()=>{},ready:async()=>{}};
  try { await fn(options); } finally { await fs.rm(dir,{recursive:true,force:true}); }
}
test('provider edit preserves secrets, routes and unrelated multiline settings',()=>{
  const source=original+'MULTILINE="first\nsecond"\n';
  const result=updateProviders(source,'yandex');
  assert.equal(result,source.replaceAll('PROVIDER=openai','PROVIDER=yandex'));
  assert.deepEqual(Object.values(selectProviders(parse(result))),['yandex','yandex','yandex']);
  assert.throws(()=>updateProviders(source+'export AI_TEXT_PROVIDER = openai\n','yandex'),/DUPLICATE/);
  assert.throws(()=>updateProviders(source,'other'),/INVALID/);
});
test('failed preflight and check-only never edit environment or restart',()=>fixture(async options=>{
  let restarts=0; options.restart=async()=>restarts++;
  await assert.rejects(switchAI({...options,probe:async()=>{throw new Error('failed');}}));
  await switchAI({...options,checkOnly:true});
  assert.equal(await fs.readFile(options.envPath,'utf8'),original);assert.equal(restarts,0);
  await assert.rejects(fs.access(path.join(options.stateDir,'latest.json')));
}));
test('successful switch snapshots securely; rollback restores exact original',()=>fixture(async options=>{
  const result=await switchAI(options);
  assert.equal((await fs.stat(result.backup)).mode&0o777,0o600);
  assert.equal((await fs.stat(options.envPath)).mode&0o777,0o600);
  assert.equal(await fs.readFile(result.backup,'utf8'),original);
  await switchAI({...options,rollback:true});
  assert.equal(await fs.readFile(options.envPath,'utf8'),original);
}));
test('readiness failure restores previous environment and restarts it',()=>fixture(async options=>{
  let calls=0;
  await assert.rejects(switchAI({...options,restart:async()=>calls++,ready:async env=>{if(env.AI_TEXT_PROVIDER==='yandex') throw new Error('unready');}}),/SWITCH_FAILED_PREVIOUS_RESTORED/);
  assert.equal(calls,2);assert.equal(await fs.readFile(options.envPath,'utf8'),original);
}));
test('failed recovery is reported; concurrent edits are never overwritten',()=>fixture(async options=>{
  await assert.rejects(switchAI({...options,restart:async()=>{throw new Error();}}),/RECOVERY_NEEDS_ATTENTION/);
  assert.equal(await fs.readFile(options.envPath,'utf8'),original);
  await assert.rejects(switchAI({...options,restart:async()=>{await fs.appendFile(options.envPath,'NEW=operator\n');throw new Error();}}),/RECOVERY_CONFIG_CHANGED/);
  assert.match(await fs.readFile(options.envPath,'utf8'),/NEW=operator/);
}));
test('rollback refuses changed environment; target already active does not restart',()=>fixture(async options=>{
  await switchAI(options);
  const same=await switchAI({...options,restart:async()=>{throw new Error('must not restart');}});
  assert.equal(same.changed,false);
  await fs.appendFile(options.envPath,'NEW=operator\n');
  await assert.rejects(switchAI({...options,rollback:true}),/ROLLBACK_CONFIG_CHANGED/);
}));
test('concurrent switches, unsafe env permissions and mid-probe edits are rejected',()=>fixture(async options=>{
  await fs.mkdir(options.stateDir);await fs.mkdir(path.join(options.stateDir,'lock'));
  await assert.rejects(switchAI(options),/SWITCH_ALREADY_RUNNING/);
  await fs.rmdir(path.join(options.stateDir,'lock'));
  await fs.chmod(options.envPath,0o644);
  await assert.rejects(switchAI(options),/ENV_PERMISSIONS/);
  await fs.chmod(options.envPath,0o600);
  await assert.rejects(switchAI({...options,probe:async()=>fs.appendFile(options.envPath,'NEW=x\n')}),/ENV_CHANGED_DURING_CHECK/);
}));
test('vision probe uses original PNG and rejects incorrect amount before voice request',async()=>{
  assert.equal(sampleImage().subarray(1,4).toString(),'PNG');
  let voiceCalls=0;
  const clients={createTextAI:()=>({complete:async()=>({choices:[{message:{content:'OK'}}]})}),createStatementAI:()=>({analyze:async()=>[{amount:999,type:'expense'}]}),createVoiceAI:()=>({transcribe:async()=>voiceCalls++})};
  await assert.rejects(probeAI({},clients),/STATEMENT_PROBE_FAILED/);assert.equal(voiceCalls,0);
});


test('readiness follows reverse-proxy protocol and rejects failing HTTP responses',async()=>{
  const {createServer}=await import('node:http');
  const {waitForReady}=await import('../tools/ai-switch/ready.mjs');
  let status=200;
  const server=createServer((req,res)=>{res.writeHead(req.headers['x-forwarded-proto']==='https'?status:301);res.end();});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const options={port:server.address().port,active:async()=>{},sleep:async()=>{},attempts:1};
    await waitForReady(options);
    status=500;
    await assert.rejects(waitForReady(options),/SERVICE_NOT_READY/);
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
