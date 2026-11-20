Deno.serve(() => Response.json({ error: 'Account sign-in is currently disabled.' }, {
  status: 410,
  headers: { 'Cache-Control': 'no-store' },
}));
