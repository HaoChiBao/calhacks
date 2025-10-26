
// chat request
fetch('http://localhost:8080/api/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    message: 'Coffee, art, and a short evening walk',
    destination: 'Shibuya, Tokyo',
    radiusMeters: 1500,
    preferences: { budget: 'medium', vibe: 'chill' }
  })
})
  .then(async r => {
    console.log('status:', r.status);
    const json = await r.json().catch(() => ({}));
    console.log('body:', json);
  })
  .catch(console.error);
