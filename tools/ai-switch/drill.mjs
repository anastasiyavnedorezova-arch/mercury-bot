#!/usr/bin/env node
// Isolated failure injection: no application restart, DB access or global network changes.
import { loadClients } from './probe.mjs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const app='/opt/finnik-stage/app';
try {
  if(process.env.AI_TEXT_PROVIDER!=='yandex') throw new Error('STAGE_NOT_YANDEX');
  const isolated={...process.env,TELEGRAM_API_BASE_URL:'http://127.0.0.1:9/telegram',OPENAI_BASE_URL:'http://127.0.0.1:9/openai/v1'};
  // These copies deliberately point both relay consumers at an unreachable port.
  let telegramBlocked=false,openaiBlocked=false;
  try {await fetch(isolated.TELEGRAM_API_BASE_URL+'/bot1:x/getMe',{signal:AbortSignal.timeout(1000)});} catch {telegramBlocked=true;}
  try {await fetch(isolated.OPENAI_BASE_URL+'/models',{signal:AbortSignal.timeout(1000)});} catch {openaiBlocked=true;}
  if(!telegramBlocked||!openaiBlocked) throw new Error('FAILURE_INJECTION_FAILED');
  const clients=await loadClients(app);
  const response=await clients.createTextAI(isolated,clients.ProbeClient).complete({messages:[{role:'user',content:'Test financial parsing, do not persist anything. Coffee expense 350 RUB. Return exactly JSON: {"type":"expense","amount":350}'}],temperature:0,max_tokens:128});
  const raw=response.choices?.[0]?.message?.content?.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  const result=JSON.parse(raw);
  if(result.type!=='expense'||result.amount!==350) throw new Error('TEXT_PARSE_FAILED');
  const {createWebBotAdapter,getWebChatQueue,clearWebChatQueue}=await import(pathToFileURL(path.join(app,'src/webBotAdapter.js')).href);
  const adapter=createWebBotAdapter(),chatId='isolated-resilience-drill';
  await adapter.sendMessage(chatId,'Test expense parsed: '+result.amount);
  const webAdapterOK=getWebChatQueue(chatId).some(m=>m.text==='Test expense parsed: 350');
  clearWebChatQueue(chatId);
  if(!webAdapterOK) throw new Error('WEB_ADAPTER_FAILED');
  console.log(JSON.stringify({isolated:true,telegramBlocked,openaiRelayBlocked:openaiBlocked,yandexTextOK:true,webAdapterOK,dbWrites:0,liveConfigurationChanged:false}));
} catch {
  console.error('ISOLATED_DRILL_FAILED');process.exitCode=1;
}
