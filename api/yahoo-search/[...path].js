const { proxyGet } = require('../_lib/proxy')

module.exports = async function handler(req, res) {
  await proxyGet(req, res, {
    base: 'https://query2.finance.yahoo.com',
    withYahooHeaders: true,
  })
}
