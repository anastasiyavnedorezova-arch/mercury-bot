import test from 'node:test';
import assert from 'node:assert/strict';
import {createEmailNewsSettings} from '../public/cabinet/email-news.js';
function fixture(save=async accepted=>({accepted})) {
 const states=[],saved=[];let opened=0;
 const ui=createEmailNewsSettings({savePreference:async value=>{saved.push(value);return save(value);},openPersonalData:()=>opened++,changed:s=>states.push(s)});
 return {ui,states,saved,get opened(){return opened;},get last(){return states.at(-1);}};
}
test('existing email switches immediately without opening personal data',async()=>{
 const f=fixture();f.ui.render({email:'qa@example.invalid',email_letters_accepted:false});
 await f.ui.toggle(true);assert.deepEqual(f.saved,[true]);assert.equal(f.opened,0);assert.equal(f.last.accepted,true);
 await f.ui.toggle(false);assert.deepEqual(f.saved,[true,false]);assert.equal(f.last.accepted,false);
});
test('missing email opens the dialog but does not grant consent before save',async()=>{
 const f=fixture();f.ui.render({email:null,email_letters_accepted:false});await f.ui.toggle(true);
 assert.equal(f.opened,1);assert.deepEqual(f.saved,[]);assert.equal(f.last.accepted,false);assert.equal(f.ui.wantsEmailConsent(),true);
 const pending=f.ui.wantsEmailConsent();f.ui.cancelEmailEntry();
 await f.ui.personalDataSaved({email:'qa@example.invalid',email_letters_accepted:false},pending);
 assert.deepEqual(f.saved,[true]);assert.equal(f.last.accepted,true);assert.equal(f.ui.wantsEmailConsent(),false);
});
test('cancel and ordinary personal-data edits never subscribe the user',async()=>{
 const f=fixture();f.ui.render({email:null});await f.ui.toggle(true);f.ui.cancelEmailEntry();
 assert.equal(f.ui.wantsEmailConsent(),false);assert.equal(f.last.accepted,false);
 await f.ui.personalDataSaved({email:'qa@example.invalid',email_letters_accepted:false},false);
 assert.deepEqual(f.saved,[]);assert.equal(f.last.accepted,false);
});
test('preference errors restore saved state; double clicks cannot dispatch twice',async()=>{
 let finish;const f=fixture(()=>new Promise((resolve,reject)=>{finish=reject;}));
 f.ui.render({email:'qa@example.invalid',email_letters_accepted:false});
 const first=f.ui.toggle(true);await f.ui.toggle(true);assert.deepEqual(f.saved,[true]);finish(new Error('network'));await first;
 assert.equal(f.last.accepted,false);assert.equal(f.last.busy,false);assert.match(f.last.error,/Не получилось/);
});
test('blocked delivery cannot be enabled; empty email after save cannot grant consent',async()=>{
 const f=fixture();f.ui.render({email:'qa@example.invalid',email_delivery_blocked:true});await f.ui.toggle(true);assert.deepEqual(f.saved,[]);
 await f.ui.personalDataSaved({email:null},true);assert.deepEqual(f.saved,[]);
});
