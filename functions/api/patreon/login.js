export function onRequest(context) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: context.env.PATREON_CLIENT_ID,
    redirect_uri: 'https://primemods-website.kwmax.workers.dev/api/patreon/callback',
    scope: 'identity identity.memberships'
  });
  return Response.redirect(
    'https://www.patreon.com/oauth2/authorize?' + params.toString(),
    302
  );
}