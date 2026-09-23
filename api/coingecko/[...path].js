const { proxyGet } = require('../_lib/proxy')

module.exports = async function handler(req, res) {
  await proxyGet(req, res, {
    base: 'https://api.coingecko.com/api/v3',
  })
}
