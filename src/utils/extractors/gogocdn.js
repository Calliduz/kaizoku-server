const axios = require('axios');
const cheerio = require('cheerio');
const CryptoJS = require('crypto-js');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

class GogoCDN {
  constructor() {
    this.serverName = 'goload';
    this.sources = [];
    this.keys = {
      key: CryptoJS.enc.Utf8.parse('37911490979715163134003223491201'),
      secondKey: CryptoJS.enc.Utf8.parse('54674138327930866480207815084989'),
      iv: CryptoJS.enc.Utf8.parse('3134003223491201'),
    };
    this.referer = '';
  }

  async extract(videoUrl) {
    this.sources = [];
    const url = typeof videoUrl === 'string' ? new URL(videoUrl) : videoUrl;
    this.referer = url.href;

    try {
      const res = await axios.get(url.href, {
        headers: { 'User-Agent': USER_AGENT }
      });
      const $ = cheerio.load(res.data);

      const encryptedParams = await this.generateEncryptedAjaxParams(
        $,
        url.searchParams.get('id') ?? ''
      );

      const encryptedData = await axios.get(
        `${url.protocol}//${url.hostname}/encrypt-ajax.php?${encryptedParams}`,
        {
          headers: {
            'X-Requested-With': 'XMLHttpRequest',
            'Referer': url.href,
            'User-Agent': USER_AGENT
          },
        }
      );

      const decryptedData = await this.decryptAjaxData(encryptedData.data.data);
      if (!decryptedData.source) throw new Error('No source found. Try a different server.');

      decryptedData.source.forEach((source) => {
        this.sources.push({
          url: source.file,
          isM3U8: source.file.includes('.m3u8'),
        });
      });
      
      if (decryptedData.source_bk) {
        decryptedData.source_bk.forEach((source) => {
          this.sources.push({
            url: source.file,
            isM3U8: source.file.includes('.m3u8'),
          });
        });
      }

      return this.sources;
    } catch (error) {
      console.error('GogoCDN Extraction Error:', error.message);
      return [];
    }
  }

  async generateEncryptedAjaxParams($, id) {
    const encryptedKey = CryptoJS.AES.encrypt(id, this.keys.key, {
      iv: this.keys.iv,
    });

    const scriptValue = $("script[data-name='episode']").data().value;

    const decryptedToken = CryptoJS.AES.decrypt(scriptValue, this.keys.key, {
      iv: this.keys.iv,
    }).toString(CryptoJS.enc.Utf8);

    return `id=${encryptedKey}&alias=${id}&${decryptedToken}`;
  }

  async decryptAjaxData(encryptedData) {
    const decryptedData = CryptoJS.enc.Utf8.stringify(
      CryptoJS.AES.decrypt(encryptedData, this.keys.secondKey, {
        iv: this.keys.iv,
      })
    );

    return JSON.parse(decryptedData);
  }
}

module.exports = GogoCDN;
