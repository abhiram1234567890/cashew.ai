import { createClient } from 'npm:@supabase/supabase-js@2.49.8';
import { generateAuthenticationOptions, generateRegistrationOptions,
  verifyAuthenticationResponse, verifyRegistrationResponse } from 'npm:@simplewebauthn/server@13.2.2';
import { isoBase64URL } from 'npm:@simplewebauthn/server@13.2.2/helpers';

const rpID = 'cashew-ai.vercel.app';
const origin = 'https://' + rpID;
const url = Deno.env.get('SUPABASE_URL')!;
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const headers = {
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Headers': 'content-type, authorization, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
};
class Problem extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
function reject(message: string): never { throw new Problem(400, message); }
function checked<T>(result: {data: T; error: unknown}): T {
  if (result.error) throw new Error('Database operation failed');
  return result.data;
}
Deno.serve(async req => {
  if (req.headers.get('origin') !== origin) return new Response(null, {status: 403});
  if (req.method === 'OPTIONS') return new Response(null, {status: 204, headers});
  const reply = (body: unknown, status = 200) => Response.json(body, {status, headers});
  if (req.method !== 'POST') return reply({error:'Use POST'}, 405);
  try {
    const raw = await req.text();
    if (raw.length > 65000) throw new Problem(413, 'Request too large.');
    const body = JSON.parse(raw);
    const db = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, options);
    const client = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, options);
    const keys = () => db.from('cashew_passkeys');
    const challenges = () => db.from('cashew_challenges');
    async function requireOwner(id: string, email: string) {
      const token = req.headers.get('authorization')?.replace(/^Bearer /i,'');
      if (!token) reject('Sign in to your existing account first to add a passkey.');
      const {data, error} = await client.auth.getUser(token);
      if (error || data.user?.id !== id || !data.user.email_confirmed_at ||
          data.user.email?.toLowerCase() !== email)
        reject('Sign in to your existing account first to add a passkey.');
    }
    if (body.step === 'begin') {
      const email = String(body.email ?? '').trim().toLowerCase();
      if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
          email.endsWith('@passkey.cashew.invalid')) reject('Enter a valid email.');
      if (body.action !== 'continue' && body.action !== 'register') reject('Invalid action.');
      const now = new Date().toISOString();
      checked(await challenges().delete().lt('expires_at',now));
      const rate = await challenges().select('id',{count:'exact',head:true}).eq('email',email);
      if (rate.error) throw new Error('Challenge lookup failed');
      if ((rate.count ?? 0) >= 12) throw new Problem(429,'Too many requests. Try again in five minutes.');
      const account = checked(await keys().select('owner_id,legacy,credential_id').eq('email',email).maybeSingle());
      const action = body.action === 'continue' && account?.credential_id ? 'login' : 'register';
      let owner = crypto.randomUUID() as string;
      let legacy = false;
      if (action === 'register') {
        if (account?.credential_id) reject('An account already uses this email. Choose Sign in.');
        if (account) {
          await requireOwner(account.owner_id,email);
          owner = account.owner_id;
          legacy = true;
        }
      }
      const publicKey = action === 'register'
        ? await generateRegistrationOptions({rpName:'Cashew.ai',rpID,userName:email,
            userID:new TextEncoder().encode(owner),attestationType:'none',timeout:120000,
            authenticatorSelection:{residentKey:'required',userVerification:'required'}})
        : await generateAuthenticationOptions({rpID,userVerification:'required',timeout:120000});
      const ticket = checked(await challenges().insert({action,email,owner_id:owner,legacy,
        challenge:publicKey.challenge}).select('id').single());
      return reply({action,ticket:ticket.id,publicKey});
    }
    if (body.step !== 'finish' || typeof body.ticket !== 'string' || !body.credential?.id)
      reject('Invalid passkey response.');
    const ticket = checked(await challenges().delete().eq('id',body.ticket)
      .gt('expires_at',new Date().toISOString()).select('*').maybeSingle());
    if (!ticket) reject('This request expired. Please try again.');
    const expected = {expectedOrigin:origin,expectedRPID:rpID,expectedChallenge:ticket.challenge,
      requireUserVerification:true};
    let owner = ticket.owner_id;
    let legacy = ticket.legacy;
    if (ticket.action === 'register') {
      if (legacy) await requireOwner(owner,ticket.email);
      const result = await verifyRegistrationResponse({...expected,response:body.credential});
      if (!result.verified || !result.registrationInfo) reject('Passkey registration failed.');
      const {credential} = result.registrationInfo;
      const values = {credential_id:credential.id,public_key:isoBase64URL.fromBuffer(credential.publicKey),
        counter:credential.counter};
      const write = legacy
        ? await keys().update(values).eq('owner_id',owner).eq('legacy',true).is('credential_id',null).select('owner_id').single()
        : await keys().insert({...values,owner_id:owner,email:ticket.email,legacy:false}).select('owner_id').single();
      if (write.error) reject('Could not add this passkey. Try signing in to the existing account.');
      if (legacy) return reply({linked:true});
    } else {
      const key = checked(await keys().select('*').eq('credential_id',body.credential.id)
        .eq('email',ticket.email).maybeSingle());
      if (!key) reject('This passkey does not match that email.');
      const result = await verifyAuthenticationResponse({...expected,response:body.credential,
        credential:{id:key.credential_id,publicKey:isoBase64URL.toBuffer(key.public_key),counter:key.counter}});
      if (!result.verified) reject('Passkey verification failed.');
      const counter = result.authenticationInfo.newCounter;
      if (counter !== key.counter) checked(await keys().update({counter}).eq('owner_id',key.owner_id)
        .eq('counter',key.counter).select('owner_id').single());
      owner = key.owner_id;
      legacy = key.legacy;
    }
    // Bind the Supabase session to the verified credential's immutable owner.
    // The user-entered email is a profile label for new accounts.
    let lookup = await db.auth.admin.getUserById(owner);
    if (!legacy && lookup.error?.status === 404) {
      const created = await db.auth.admin.createUser({id:owner,email:owner+'@passkey.cashew.invalid',
        email_confirm:true,app_metadata:{cashew_passkey:owner}});
      if (created.error && created.error.status !== 422) throw new Error('Account provisioning failed');
      lookup = await db.auth.admin.getUserById(owner);
    }
    const identity = lookup.data.user;
    if (lookup.error || !identity?.email || identity.id !== owner ||
        (!legacy && identity.app_metadata.cashew_passkey !== owner))
      throw new Error('Account unavailable');
    if (!legacy) checked(await db.from('profiles').update({email:ticket.email}).eq('id',owner).select('id').single());
    // generateLink is server-only and sends no email. The one-time token stays on the server.
    const grant = await db.auth.admin.generateLink({type:'magiclink',email:identity.email});
    if (grant.error || grant.data.user.id !== owner) throw new Error('Session grant failed');
    const login = await client.auth.verifyOtp({type:'email',token_hash:grant.data.properties.hashed_token});
    if (login.error || !login.data.session || login.data.user?.id !== owner) throw new Error('Session creation failed');
    const {access_token,refresh_token} = login.data.session;
    return reply({access_token,refresh_token});
  } catch (error) {
    const status = error instanceof Problem ? error.status : 400;
    return reply({error:error instanceof Problem ? error.message : 'Could not complete the passkey request. Please try again.'},status);
  }
});
