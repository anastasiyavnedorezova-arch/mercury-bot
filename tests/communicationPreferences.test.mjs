import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import express from 'express';
import jwt from 'jsonwebtoken';
import {makeDb} from './helpers/testDb.mjs';
import {EMAIL_OFFERS,EMAIL_CONSENT_VERSION,emailConsentFields,emailEnabled,offerEmailNews,answerEmailOffer,setEmailPreference,maybeShowCommunication,REGISTRATION_EMAIL_TEXT} from '../src/utils/communicationPreferences.js';
import {createEmailPreferencesRouter} from '../src/cabinet/emailPreferences.js';
import {requireAuth,requireActiveAccount} from '../src/authMiddleware.js';
import {decideLetter} from '../src/emails/chain.js';
let ctx,db;
const start=new Date('2026-11-07T11:00:00Z');const later=days=>new Date(start.getTime()+days*86400000);
const enabled={COMMUNICATION_ONBOARDING_ENABLED:'true',NEWS_CHANNEL_URL:'https://t.me/+fixture_channel'};
const bot=(isWeb=true)=>{const sent=[];return {isWeb,sent,sendMessage:async(id,text,opts)=>sent.push({id,text,opts})};};
const user=async fields=>{const id=crypto.randomUUID();const {error}=await db.from('users').insert({id,external_id:id,channel:'web',email:'test@example.com',...fields});assert.ifError(error);return id;};
const row=async id=>(await db.from('users').select('*').eq('id',id).single()).data;
before(async()=>{ctx=await makeDb();db=ctx.db;});after(async()=>ctx?.close());
test('three different texts, stage-specific buttons and 3/7-day deferrals persist',async()=>{
 const id=await user();const one=await offerEmailNews(db,id,start);assert.equal(one.stage,1);
 assert.equal(await offerEmailNews(db,id,start),null,'no repetition before a choice');
 await answerEmailOffer(db,id,1,'later',start);
 assert.equal(await offerEmailNews(db,id,later(2.999)),null);
 const two=await offerEmailNews(db,id,later(3));assert.equal(two.stage,2);
 await answerEmailOffer(db,id,2,'later',later(3));
 assert.equal(await offerEmailNews(db,id,later(9.999)),null);
 const three=await offerEmailNews(db,id,later(10));assert.equal(three.stage,3);
 assert.equal(new Set([one.text,two.text,three.text]).size,3);
 assert.deepEqual(three.options.reply_markup.inline_keyboard[0].map(b=>b.text),['Принять','Отказаться']);
 await answerEmailOffer(db,id,3,'decline',later(10));
 assert.equal(await offerEmailNews(db,id,later(500)),null);
 const u=await row(id);assert.ok(u.email_offer_declined_at);assert.equal(u.email_letters_accepted,false);
});
test('accepting any stage records date/source/version and enables existing email flag',async()=>{
 for(const stage of [1,2,3]) {
  const id=await user({email_offer_count:stage-1});
  if(stage>1) await db.from('users').update({email_offer_next_at:start.toISOString()}).eq('id',id);
  await offerEmailNews(db,id,start);await answerEmailOffer(db,id,stage,'accept',start);
  const u=await row(id);assert.equal(emailEnabled(u),true);assert.equal(u.email_consent_source,`web_offer_${stage}`);assert.equal(u.email_consent_version,EMAIL_CONSENT_VERSION);assert.equal(new Date(u.email_consent_updated_at).toISOString(),start.toISOString());
  assert.equal(await offerEmailNews(db,id,later(30)),null);
  const events=await db.from('email_consent_events').select('*').eq('user_id',id);assert.equal(events.data.length,1);assert.equal(events.data[0].accepted,true);
 }
});
test('existing registration consent, unsubscribe, delivery block and inactive users suppress offers',async()=>{
 for(const fields of [{...emailConsentFields(true,'registration',start)},{email_unsubscribed_at:start.toISOString()},{email_blocked_at:start.toISOString()},{email:null},{status:'deleted'},{status:'merged'}]) assert.equal(await offerEmailNews(db,await user(fields),start),null);
});
test('duplicate/stale callbacks cannot advance attempts or reverse a later choice',async()=>{
 const id=await user();await offerEmailNews(db,id,start);await answerEmailOffer(db,id,1,'later',start);
 assert.equal((await answerEmailOffer(db,id,1,'later',start)).stale,true);
 await offerEmailNews(db,id,later(3));assert.equal((await answerEmailOffer(db,id,1,'accept',later(3))).stale,true);
 assert.equal((await row(id)).email_letters_accepted,false);
 await assert.rejects(answerEmailOffer(db,id,2,'decline',later(3)),/INVALID/);
 await assert.rejects(answerEmailOffer(db,id,3,'later',later(3)),/INVALID/);
});
test('profile toggles on/off after final decline and explicit off stops all future offers',async()=>{
 const id=await user({email_offer_declined_at:start.toISOString(),email_offer_count:3});
 await setEmailPreference(db,id,true,'profile',start);assert.equal(emailEnabled(await row(id)),true);
 await setEmailPreference(db,id,false,'profile',later(1));assert.equal(emailEnabled(await row(id)),false);
 assert.equal(await offerEmailNews(db,id,later(200)),null);
 const events=(await db.from('email_consent_events').select('*').eq('user_id',id)).data;assert.equal(events.length,2);
 await setEmailPreference(db,id,false,'profile',later(2));assert.equal((await db.from('email_consent_events').select('*').eq('user_id',id)).data.length,2,'idempotent');
 await assert.rejects(setEmailPreference(db,id,'true'),/INVALID/);
});
test('profile never enables missing/blocked email and does not clear delivery suppression',async()=>{
 const missing=await user({email:null});await assert.rejects(setEmailPreference(db,missing,true),/EMAIL_REQUIRED/);
 const blocked=await user({email_blocked_at:start.toISOString()});await assert.rejects(setEmailPreference(db,blocked,true),/EMAIL_BLOCKED/);assert.ok((await row(blocked)).email_blocked_at);
});
test('web sends once; failed delivery does not consume first or repeat attempt',async()=>{
 const id=await user(),b=bot();assert.equal(await maybeShowCommunication(b,77,id,{db,env:enabled,now:start}),true);assert.equal(b.sent.length,1);
 assert.equal(await maybeShowCommunication(b,77,id,{db,env:enabled,now:start}),false);
 await answerEmailOffer(db,id,1,'later',start);
 const bad={isWeb:true,sendMessage:async()=>{throw new Error('network');}};
 assert.equal(await maybeShowCommunication(bad,77,id,{db,env:enabled,now:later(3)}),false);
 assert.equal((await row(id)).email_offer_count,1);
 assert.equal(await maybeShowCommunication(b,77,id,{db,env:enabled,now:later(3)}),true);assert.equal((await row(id)).email_offer_count,2);
});
test('Telegram invitation uses configured URL once, independent of email prompts',async()=>{
 const id=await user({channel:'telegram'}),b=bot(false);
 assert.equal(await maybeShowCommunication(b,77,id,{db,env:enabled,now:start}),true);
 assert.equal(b.sent[0].opts.reply_markup.inline_keyboard[0][0].url,enabled.NEWS_CHANNEL_URL);
 assert.equal(await maybeShowCommunication(b,77,id,{db,env:enabled,now:start}),false);
 assert.equal((await row(id)).email_offer_count,0);
 assert.equal(await maybeShowCommunication(bot(),77,id,{db,env:{},now:start}),false);
});
test('registration and external unsubscribe decisions are audited without rewriting historical consent',async()=>{
 const id=await user({...emailConsentFields(true,'registration',start)});
 let events=(await db.from('email_consent_events').select('*').eq('user_id',id)).data;assert.equal(events[0].source,'registration');
 await db.from('users').update(emailConsentFields(false,'email_unsubscribe',later(1))).eq('id',id);
 events=(await db.from('email_consent_events').select('*').eq('user_id',id)).data;assert.equal(events.length,2);assert.ok(events.some(e=>e.source==='email_unsubscribe'&&!e.accepted));
});
test('existing chain can select marketing after opt-in; sent-letter history still prevents duplicates',()=>{
 // No new dispatch is started by a consent change; normal chain rules remain in force.
 const f={now:later(2),user:{created_at:start.toISOString(),email_letters_accepted:true},sent:{welcome:{status:'sent',sent_at:start.toISOString()}},isNew:true,hasTransactions:false,subs:[],payReady:true};
 assert.equal(decideLetter({...f,user:{...f.user,email_letters_accepted:false}}),null);
 assert.equal(decideLetter(f)?.key,'activation');
 assert.equal(decideLetter({...f,sent:{...f.sent,activation:{status:'sent',sent_at:f.now.toISOString()}}}),null);
 assert.equal(decideLetter({...f,user:{...f.user,email_unsubscribed_at:start.toISOString()}}),null);
});
test('profile preference endpoint requires active authenticated owner and validates boolean',async()=>{
 process.env.JWT_SECRET='communication-test-only-secret';
 const owner=await user(),other=await user(),deleted=await user({status:'deleted'});
 const app=express();app.use(express.json());app.use(createEmailPreferencesRouter({db,requireAuth:[requireAuth,requireActiveAccount(db)]}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const url=`http://127.0.0.1:${server.address().port}/api/profile/email-preference`;
 const post=(body,id)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...(id?{Authorization:'Bearer '+jwt.sign({userId:id},process.env.JWT_SECRET)}:{})},body:JSON.stringify(body)});
 try {
  assert.equal((await post({accepted:true})).status,401);
  assert.equal((await post({accepted:true},deleted)).status,401);
  assert.equal((await post({accepted:'true'},owner)).status,400);
  const response=await post({accepted:true,user_id:other},owner);assert.equal(response.status,200);
  assert.equal(emailEnabled(await row(owner)),true);assert.equal(emailEnabled(await row(other)),false);
 } finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('registration label and profile controls explain scope and preserve independent opt-in',()=>{
 const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
 assert.ok(read('public/cabinet/register.html').includes(REGISTRATION_EMAIL_TEXT));
 const profile=read('public/cabinet/profile.html');assert.match(profile,/Новости и предложения по email/);assert.match(profile,/emailNewsEnabled/);assert.match(profile,/Сервисные письма об аккаунте и подписке/);
 assert.equal(EMAIL_OFFERS.length,3);assert.ok(EMAIL_OFFERS.every(t=>t.includes('скидки')));
});

test('parallel widget opens claim one offer; record processing cannot trigger a repeat',async()=>{
 const id=await user();const result=await Promise.all([offerEmailNews(db,id,start),offerEmailNews(db,id,start)]);
 assert.equal(result.filter(Boolean).length,1);
 await answerEmailOffer(db,id,1,'later',start);
 assert.equal(await offerEmailNews(db,id,later(3),{allowRepeat:false}),null);
 assert.equal((await offerEmailNews(db,id,later(3))).stage,2);
});
