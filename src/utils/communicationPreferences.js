export const EMAIL_CONSENT_VERSION = 'email-news-2026-11-07-v1';
export const REGISTRATION_EMAIL_TEXT = 'Хочу получать письма Финника: новости, обновления, предупреждения о технических работах и промокоды на скидки';
export const EMAIL_OFFERS = [
  '💌 Давай оставаться на связи!\nБуду присылать на почту важные новости Финника: обновления, предупреждения о технических работах и промокоды на скидки 🎁\nНажимая «Принять», ты соглашаешься получать эти письма. Отписаться можно в любом письме или в настройках профиля 💛',
  '📬 Хочешь узнавать, что нового у Финника?\nРасскажу по почте о полезных обновлениях, заранее предупрежу о запланированных работах и поделюсь промокодами на скидки.\nНажми «Принять», чтобы согласиться на эти письма. Передумать можно в любой момент — в письме или профиле 💛',
  '💛 Как тебе удобнее: получать новости Финника на почту или обойтись без писем?\nВ рассылке — обновления, предупреждения о технических работах и промокоды на скидки. «Принять» — согласиться на эти письма.\nЕсли выберешь «Отказаться», больше предлагать не буду. Позже включить или отключить рассылку можно в профиле.',
];
const DAY=86400000;
const inactive=u=>!u||['deleted','merged'].includes(u.status);
export const emailEnabled=u=>u.email_letters_accepted===true&&!u.email_unsubscribed_at;
export function emailConsentFields(accepted,source,now=new Date()) {
  return {email_letters_accepted:accepted,email_unsubscribed_at:accepted?null:now.toISOString(),email_consent_updated_at:now.toISOString(),email_consent_source:source,email_consent_version:EMAIL_CONSENT_VERSION};
}
export async function setEmailPreference(db,userId,accepted,source='profile',now=new Date()) {
  if(typeof accepted!=='boolean') throw new Error('INVALID_EMAIL_PREFERENCE');
  return db.transaction(async tx=>{
    const {rows:[u]}=await tx.query('SELECT * FROM users WHERE id=$1 FOR UPDATE',[userId]);
    if(inactive(u)) throw new Error('ACCOUNT_INACTIVE');
    if(accepted&&!u.email) throw new Error('EMAIL_REQUIRED');
    if(accepted&&u.email_blocked_at) throw new Error('EMAIL_BLOCKED');
    if(emailEnabled(u)===accepted && (accepted||u.email_offer_declined_at)) return {accepted,changed:false};
    const f=emailConsentFields(accepted,source,now);
    await tx.query(`UPDATE users SET email_letters_accepted=$2,email_unsubscribed_at=$3,email_consent_updated_at=$4,
      email_consent_source=$5,email_consent_version=$6,email_offer_active=NULL,email_offer_next_at=NULL,email_offer_declined_at=$7 WHERE id=$1`,
    [userId,accepted,f.email_unsubscribed_at,f.email_consent_updated_at,source,f.email_consent_version,accepted?null:now.toISOString()]);
    return {accepted,changed:true};
  });
}
export async function offerEmailNews(db,userId,now=new Date(),{allowRepeat=true}={}) {
  return db.transaction(async tx=>{
    const {rows:[u]}=await tx.query('SELECT * FROM users WHERE id=$1 FOR UPDATE',[userId]);
    if(inactive(u)||!u.email||emailEnabled(u)||u.email_blocked_at||u.email_unsubscribed_at||u.email_offer_declined_at||u.email_offer_active||u.email_offer_count>=3) return null;
    if(!allowRepeat&&u.email_offer_count>0) return null;
    if(u.email_offer_count>0&&(!u.email_offer_next_at||Date.parse(u.email_offer_next_at)>now.getTime())) return null;
    const stage=u.email_offer_count+1;
    await tx.query('UPDATE users SET email_offer_count=$2,email_offer_active=$2,email_offer_shown_at=$3,email_offer_next_at=NULL WHERE id=$1',[userId,stage,now.toISOString()]);
    return {stage,text:EMAIL_OFFERS[stage-1],options:{reply_markup:{inline_keyboard:[[
      {text:'Принять',callback_data:`email-news:${stage}:accept`},
      {text:stage===3?'Отказаться':'Не сейчас',callback_data:`email-news:${stage}:${stage===3?'decline':'later'}`},
    ]]}}};
  });
}
export async function answerEmailOffer(db,userId,stage,decision,now=new Date()) {
  if(![1,2,3].includes(stage)||!['accept','later','decline'].includes(decision)||decision==='later'&&stage===3||decision==='decline'&&stage!==3) throw new Error('INVALID_EMAIL_OFFER');
  return db.transaction(async tx=>{
    const {rows:[u]}=await tx.query('SELECT * FROM users WHERE id=$1 FOR UPDATE',[userId]);
    if(inactive(u)) throw new Error('ACCOUNT_INACTIVE');
    if(u.email_offer_active!==stage||emailEnabled(u)||u.email_offer_declined_at||u.email_unsubscribed_at) return {stale:true};
    if(decision==='later') {
      await tx.query('UPDATE users SET email_offer_active=NULL,email_offer_next_at=$2 WHERE id=$1',[userId,new Date(now.getTime()+(stage===1?3:7)*DAY).toISOString()]);
      return {text:stage===1?'Хорошо, вернёмся к этому позже 💛':'Хорошо, пока оставим без писем 💛'};
    }
    if(decision==='accept'&&(!u.email||u.email_blocked_at)) throw new Error(u.email?'EMAIL_BLOCKED':'EMAIL_REQUIRED');
    const accepted=decision==='accept',f=emailConsentFields(accepted,`web_offer_${stage}`,now);
    await tx.query(`UPDATE users SET email_letters_accepted=$2,email_unsubscribed_at=$3,email_consent_updated_at=$4,
      email_consent_source=$5,email_consent_version=$6,email_offer_active=NULL,email_offer_next_at=NULL,email_offer_declined_at=$7 WHERE id=$1`,
    [userId,accepted,f.email_unsubscribed_at,f.email_consent_updated_at,f.email_consent_source,f.email_consent_version,accepted?null:now.toISOString()]);
    return {text:accepted?'Готово! Ты согласился получать письма Финника 💌 Изменить выбор можно в профиле.':'Понял, больше предлагать не буду 💛 Включить письма позже можно в профиле.'};
  });
}
export async function maybeShowCommunication(bot,chatId,userId,{db,now=new Date(),env=process.env,firstOnly=false}={}) {
  if(env.COMMUNICATION_ONBOARDING_ENABLED!=='true') return false;
  try {
    if(bot.isWeb) {
      const offer=await offerEmailNews(db,userId,now,{allowRepeat:!firstOnly});
      if(!offer) return false;
      try {await bot.sendMessage(chatId,offer.text,offer.options);}
      catch(err) {
        // A failed send must not spend an attempt. Compare-and-set protects later choices.
        await db.transaction(tx=>tx.query('UPDATE users SET email_offer_count=email_offer_count-1,email_offer_active=NULL,email_offer_next_at=$3 WHERE id=$1 AND email_offer_active=$2 AND email_offer_shown_at=$3',[userId,offer.stage,now.toISOString()]));
        throw err;
      }
      return true;
    }
    const url=env.NEWS_CHANNEL_URL||'';
    if(!/^https:\/\/t\.me\/(?:\+[A-Za-z0-9_-]+|[A-Za-z0-9_]+)$/.test(url)) return false;
    const claimed=await db.transaction(async tx=>{
      const {rows}=await tx.query("UPDATE users SET telegram_channel_invited_at=$2 WHERE id=$1 AND telegram_channel_invited_at IS NULL AND COALESCE(status,'active') NOT IN ($3,$4) RETURNING id",[userId,now.toISOString(),'deleted','merged']);
      return rows.length>0;
    });
    if(!claimed) return false;
    try {await bot.sendMessage(chatId,'📣 Давай оставаться на связи!\nВ канале «Финник Деньги — только важные новости» я рассказываю об обновлениях и технических работах. А ещё там будут промокоды на скидки 🎁\nБез ежедневного шума — только по делу 💛',{reply_markup:{inline_keyboard:[[{text:'📣 Перейти в канал',url}]]}});}
    catch(err) {await db.transaction(tx=>tx.query('UPDATE users SET telegram_channel_invited_at=NULL WHERE id=$1 AND telegram_channel_invited_at=$2',[userId,now.toISOString()]));throw err;}
    return true;
  } catch {console.error('[communication] OFFER_FAILED');return false;}
}
