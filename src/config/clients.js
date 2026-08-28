const { Client: NotionClient } = require("@notionhq/client");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const ffprobePath = require("ffprobe-static").path;

// ffmpeg 설정
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const notion = new NotionClient({ auth: process.env.NOTION_KEY });
const DATABASE_ID = process.env.BJ_NOTION_DATABASE_ID;

module.exports = {
  notion,
  DATABASE_ID,
  ffmpeg,
};
