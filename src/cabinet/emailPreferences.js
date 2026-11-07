import {Router} from 'express';
import {setEmailPreference} from '../utils/communicationPreferences.js';
export function createEmailPreferencesRouter({db,requireAuth}) {
  const router=Router();
  router.post('/api/profile/email-preference',requireAuth,async(req,res)=>{
    try {
      if(typeof req.body?.accepted!=='boolean') return res.status(400).json({error:'INVALID_EMAIL_PREFERENCE'});
      const result=await setEmailPreference(db,req.userId,req.body.accepted,'profile');
      res.json({ok:true,...result});
    } catch(err) {
      if(['EMAIL_REQUIRED','EMAIL_BLOCKED','ACCOUNT_INACTIVE'].includes(err.message)) return res.status(400).json({error:err.message});
      console.error('[email-preference] SAVE_FAILED');res.status(500).json({error:'SAVE_FAILED'});
    }
  });
  return router;
}
