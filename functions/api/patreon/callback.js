const REDIRECT = 'https://primemods-website.kwmax.workers.dev/api/patreon/callback';
const TIERS = { supporter:'5962086', packTester:'9234196', devCouncil:'6201011', legacy:'5960935' };
const EARLY = [TIERS.packTester, TIERS.devCouncil];

export async function onRequest(context) {
  const code = new URL(context.request.url).searchParams.get('code');
  if (!code) return new Response('No code', { status: 400 });

  const tokenRes = await fetch('https://www.patreon.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      grant_type: 'authorization_code',
      client_id: context.env.PATREON_CLIENT_ID,
      client_secret: context.env.PATREON_CLIENT_SECRET,
      redirect_uri: REDIRECT
    })
  });
  const { access_token } = await tokenRes.json();

  const idRes = await fetch(
    'https://www.patreon.com/api/oauth2/v2/identity?include=memberships.currently_entitled_tiers&fields%5Buser%5D=full_name',
    { headers: { Authorization: 'Bearer ' + access_token } }
  );
  const data = await idRes.json();

  const name = data.data?.attributes?.full_name || 'Patron';
  const tierIds = (data.included || [])
    .filter(x => x.type === 'tier')
    .map(x => x.id);

  const paid = tierIds.some(id => Object.values(TIERS).includes(id));
  const early = tierIds.some(id => EARLY.includes(id));
  const session = JSON.stringify({ name, paid, early });

  return new Response(null, {
    status: 302,
    headers: {
      Location: '/downloads',
      'Set-Cookie': `phdt=${encodeURIComponent(session)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`
    }
  });
}