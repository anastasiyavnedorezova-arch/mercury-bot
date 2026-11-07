// UI flow shared by the switch and the personal-data dialog. No automatic opt-in on email edits.
export function createEmailNewsSettings({savePreference,openPersonalData,changed}) {
  const state={loaded:false,email:'',accepted:false,blocked:false,busy:false,pending:false,error:''};
  const emit=()=>changed({...state});
  async function save(accepted) {
    if(state.busy) return;
    state.busy=true;state.error='';emit();
    try {const result=await savePreference(accepted);state.accepted=result.accepted;}
    catch {state.error='Не получилось сохранить выбор. Попробуй ещё раз.';}
    finally {state.busy=false;emit();}
  }
  return {
    render(profile) {
      state.email=(profile.email||'').trim();state.accepted=profile.email_letters_accepted===true;
      state.blocked=!!profile.email_delivery_blocked;state.loaded=true;emit();
    },
    async toggle(accepted) {
      if(!state.loaded||state.busy) return;
      if(accepted&&!state.email) {state.pending=true;state.error='';emit();openPersonalData();return;}
      if(accepted&&state.blocked) return;
      await save(accepted);
    },
    cancelEmailEntry() {state.pending=false;emit();},
    async personalDataSaved(profile,enableRequested) {
      state.pending=false;this.render(profile);
      if(enableRequested&&state.email) await save(true);
    },
    wantsEmailConsent:()=>state.pending,
  };
}
