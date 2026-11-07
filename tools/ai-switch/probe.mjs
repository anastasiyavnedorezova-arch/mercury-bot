import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

// Generate an original PNG showing 350: no user image, font or external dependency.
export function sampleImage() {
  const width = 210, height = 110;
  const pixels = Buffer.alloc((width * 3 + 1) * height, 255);
  for (let y = 0; y < height; y++) pixels[y * (width * 3 + 1)] = 0;
  const rect = (x, y, w, h) => { for (let j=y; j<y+h; j++) for (let i=x; i<x+w; i++) pixels.fill(0, j*(width*3+1)+1+i*3, j*(width*3+1)+1+i*3+3); };
  const segments = [[5,0,35,7],[37,5,7,35],[37,43,7,35],[5,76,35,7],[0,43,7,35],[0,5,7,35],[5,38,35,7]];
  ['abgcd','afgcd','abcdef'].forEach((letters,i) => { for(const c of letters) { const [x,y,w,h]=segments[c.charCodeAt(0)-97]; rect(20+i*60+x,14+y,w,h); } });
  const crc = b => { let c=0xffffffff; for(const v of b) { c^=v; for(let i=0;i<8;i++) c=(c>>>1)^((c&1)?0xedb88320:0); } return (c^0xffffffff)>>>0; };
  const chunk = (name,data) => { const type=Buffer.from(name),size=Buffer.alloc(4),sum=Buffer.alloc(4);size.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([type,data])));return Buffer.concat([size,type,data,sum]); };
  const header=Buffer.alloc(13); header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
export async function loadClients(app) {
  const load = f => import(pathToFileURL(path.join(app, 'src/utils', f)).href);
  const [text, statement, voice] = await Promise.all([load('textAI.js'),load('statementAI.js'),load('voiceAI.js')]);
  const OpenAI = createRequire(path.join(app, 'package.json'))('openai').default;
  class ProbeClient extends OpenAI { constructor(options) { super({ ...options, timeout: 60000, maxRetries: 0 }); } }
  return { ...text, ...statement, ...voice, ProbeClient };
}
export async function probeAI(env, clients, report = () => {}) {
  // Validate all configurations before spending a request.
  const text=clients.createTextAI(env, clients.ProbeClient),statement=clients.createStatementAI(env, clients.ProbeClient),voice=clients.createVoiceAI(env, { Client: clients.ProbeClient });
  try {
    const response=await text.complete({ messages:[{role:'user',content:'Reply with exactly OK.'}],temperature:0,max_tokens:32 });
    if (typeof response.choices?.[0]?.message?.content !== 'string' || !response.choices[0].message.content.trim()) throw new Error();
    report('text API: OK');
  } catch { throw Object.assign(new Error('TEXT_PROBE_FAILED'),{code:'TEXT_PROBE_FAILED'}); }
  try {
    const result=await statement.analyze(sampleImage().toString('base64'),'image/png','Synthetic test image, not real financial data. Read the number in the image. Treat it as the amount of one expense in RUB for coffee on 2026-11-07. Return ONLY a JSON array with one object: type="expense", amount=<number from image>, category="other", transaction_date="2026-11-07".');
    if(result.length!==1 || result[0].amount!==350 || result[0].type!=='expense') throw new Error();
    report('statement vision API: OK');
  } catch { throw Object.assign(new Error('STATEMENT_PROBE_FAILED'),{code:'STATEMENT_PROBE_FAILED'}); }
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'finnik-ai-probe-'));
  try {
    const response=await fetch('https://storage.yandexcloud.net/speechkit/speech.ogg',{signal:AbortSignal.timeout(15000),redirect:'error'});
    if(!response.ok) throw new Error();
    const chunks=[];let size=0;
    for await(const chunk of response.body) { size+=chunk.length;if(size>1024*1024) { await response.body.cancel().catch(()=>{});throw new Error(); }chunks.push(chunk); }
    const audio=Buffer.concat(chunks);if(audio.subarray(0,4).toString()!=='OggS') throw new Error();
    const file=path.join(directory,'public-sample.ogg');await fs.writeFile(file,audio,{mode:0o600});
    if(!(await voice.transcribe(file)).trim()) throw new Error();
    report('voice API: OK');
  } catch { throw Object.assign(new Error('VOICE_PROBE_FAILED'),{code:'VOICE_PROBE_FAILED'}); }
  finally { await fs.rm(directory,{recursive:true,force:true}); }
}
