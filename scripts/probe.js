const http = require('http');
function get(path) {
  return new Promise(resolve => {
    const request = http.get({ host: '127.0.0.1', port: 3123, path }, response => {
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => resolve(`${response.statusCode} ${path} :: ${data.slice(0, 110).replace(/\n/g, ' ')}`));
    });
    request.on('error', error => resolve(`ERR ${path} ${error.code}`));
  });
}
(async () => {
  for (const path of ['/', '/admin', '/api/listings', '/api/session', '/logo.png', '/style.css', '/app.js', '/api/notifications/count', '/api/me', '/nope']) {
    console.log(await get(path));
  }
})();
