const axios = require('axios');
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

class StreamSB {
  constructor() {
    this.serverName = 'streamsb';
    this.sources = [];
    this.host = 'https://sbplay2.com/sources43';
    this.PAYLOAD = (hex) =>
      `566d337678566f743674494a7c7c${hex}7c7c346b6767586d6934774855537c7c73747265616d7362/6565417268755339773461447c7c346133383438333436313335376136323337373433383634376337633465366534393338373136643732373736343735373237613763376334363733353737303533366236333463353333363534366137633763373337343732363536313664373336327c7c6b586c3163614468645a47617c7c73747265616d7362`;
  }

  async extract(videoUrl) {
    this.sources = [];
    const url = typeof videoUrl === 'string' ? new URL(videoUrl) : videoUrl;
    
    const headers = {
      watchsb: 'streamsb',
      'User-Agent': USER_AGENT,
    };

    try {
      const id = url.href.split('/e/').pop();
      const hexId = Buffer.from(id).toString('hex');

      const res = await axios.get(`${this.host}/${this.PAYLOAD(hexId)}`, { headers });

      if (!res?.data?.stream_data) throw new Error('No source found. Try a different server.');

      const streamUrl = res.data.stream_data.file;
      const m3u8Urls = await axios.get(streamUrl, { headers });

      const videoList = m3u8Urls.data.split('#EXT-X-STREAM-INF:');

      for (const video of videoList) {
        if (!video.includes('m3u8')) continue;

        const lines = video.split('\n');
        const playbackUrl = lines[1];
        const resMatch = video.match(/RESOLUTION=\d+x(\d+)/);
        const quality = resMatch ? `${resMatch[1]}p` : 'unknown';

        this.sources.push({
          url: playbackUrl,
          quality: quality,
          isM3U8: true,
        });
      }

      this.sources.push({
        quality: 'auto',
        url: streamUrl,
        isM3U8: streamUrl.includes('.m3u8'),
      });

      return this.sources;
    } catch (error) {
      console.error('StreamSB Extraction Error:', error.message);
      return [];
    }
  }
}

module.exports = StreamSB;
