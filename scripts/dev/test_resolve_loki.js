const axios = require('axios');
const cheerio = require('cheerio');

const BASE_URL = 'https://tioplus.app';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function resolvePlayerUrl(dataServerToken) {
  try {
    const encodedForUrl = Buffer.from(dataServerToken).toString('base64');
    const playerPageUrl = `${BASE_URL}/player/${encodedForUrl}`;

    const res = await axios.get(playerPageUrl, { headers: { 'User-Agent': UA } });
    const html = typeof res.data === 'string' ? res.data : '';

    const jsRedirectMatch = html.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/i) ||
                            html.match(/location\.href\s*=\s*['"]([^'"]+)['"]/i);
    if (jsRedirectMatch) return jsRedirectMatch[1];

    const $ = cheerio.load(html);
    const iframeSrc = $('iframe').attr('src') || $('iframe').attr('data-src');
    if (iframeSrc) {
      return iframeSrc.startsWith('//') ? `https:${iframeSrc}` : iframeSrc;
    }

    const urlMatches = html.match(/https?:\/\/[^\s"'<>]+/g) || [];
    const embedUrl = urlMatches.find((u) =>
      !u.includes('tioplus') && !u.includes('cloudflare') && !u.includes('tmdb') &&
      !u.includes('google') && !u.includes('facebook') && !u.includes('fonts.googleapis') &&
      !u.includes('disqus') && !u.includes('llvpn') && !u.includes('amung')
    );
    return embedUrl || null;
  } catch (e) {
    return null;
  }
}

async function testResolveLoki() {
  const token = 'cDI3Q25sMng4M2RlSm00aUR2WmJGaFRNVnFxZnlBWHc5b1RiSjJ0OC92T1lwdW9kdTlZPQ==';
  const embed = await resolvePlayerUrl(token);
  console.log('Resolved embed URL for Loki S1:E1 token:', embed);
}

testResolveLoki();
