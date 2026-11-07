#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { waitForReady } from './ready.mjs';
import { selectProviders, switchAI } from './core.mjs';
import { loadClients, probeAI } from './probe.mjs';
const run=promisify(execFile);
const [environment,action,...flags]=process.argv.slice(2);
const safeCodes=new Set(['INVALID_PROVIDER','DUPLICATE_PROVIDER_SETTING','ENV_PERMISSIONS','ENV_CHANGED_DURING_CHECK','SWITCH_ALREADY_RUNNING','ROLLBACK_CONFIG_CHANGED','ROLLBACK_SNAPSHOT_INVALID','RECOVERY_CONFIG_CHANGED','SWITCH_FAILED_PREVIOUS_RESTORED','SWITCH_FAILED_RECOVERY_NEEDS_ATTENTION','TEXT_PROBE_FAILED','STATEMENT_PROBE_FAILED','VOICE_PROBE_FAILED']);
try {
  if(!['stage','prod'].includes(environment) || !['status','openai','yandex','rollback'].includes(action) || flags.some(f=>f!=='--check-only') || flags.length>1 || (flags.length&&action==='status')) {
    throw new Error('USAGE');
  }
  if(process.getuid?.()!==0) throw new Error('ROOT_REQUIRED');
  const app=environment==='stage'?'/opt/finnik-stage/app':'/opt/finnik/app';
  const envPath=environment==='stage'?'/etc/finnik-stage.env':'/etc/finnik-prod.env';
  const service=environment==='stage'?'finnik-stage':'finnik';
  const require=createRequire(path.join(app,'package.json'));
  const { parse }=require('dotenv');
  if(action==='status') {
    const env=parse(await fs.readFile(envPath,'utf8'));
    console.log(JSON.stringify({environment,providers:selectProviders(env)},null,2));
  } else {
    // Old production releases do not implement provider selection. Fail before writing/restarting.
    const clients=await loadClients(app);
    const result=await switchAI({envPath,stateDir:`/root/finnik-ai-switch/${environment}`,provider:action,rollback:action==='rollback',checkOnly:flags.includes('--check-only'),parse,
      probe:env=>probeAI(env,clients,message=>console.log(message)),onStep:console.log,
      restart:()=>run('systemctl',['restart',service],{timeout:45000}),
      ready:env=>waitForReady({port:Number(env.PORT || (environment==='stage'?3001:3000)),active:()=>run('systemctl',['is-active','--quiet',service],{timeout:5000})}),
    });
    console.log(JSON.stringify({environment,...result},null,2));
    console.log('Telegram/relay settings were preserved. Verify bot and web behavior separately.');
  }
} catch(err) {
  const code=safeCodes.has(err.code)?err.code:['USAGE','ROOT_REQUIRED'].includes(err.message)?err.message:err.code==='ERR_MODULE_NOT_FOUND'||err.code==='MODULE_NOT_FOUND'?'APP_PROVIDER_SUPPORT_MISSING':'SWITCH_CHECK_FAILED';
  console.error(code);
  if(code==='USAGE') console.error('Usage: finnik-ai-switch stage|prod status|openai|yandex|rollback [--check-only]');
  if(code==='APP_PROVIDER_SUPPORT_MISSING') console.error('Deploy provider-capable application first; no configuration changed.');
  if(code==='SWITCH_ALREADY_RUNNING') console.error('Check for an active command before removing a stale lock.');
  process.exitCode=1;
}
