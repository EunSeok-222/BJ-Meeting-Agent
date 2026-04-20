const { GoogleGenerativeAI } = require("@google/generative-ai");
const { GoogleAIFileManager } = require("@google/generative-ai/server");
const { Client: NotionClient } = require("@notionhq/client");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const ffprobePath = require("ffprobe-static").path;

// ffmpeg 설정
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY);
const notion = new NotionClient({ auth: process.env.NOTION_KEY });
const DATABASE_ID = process.env.BJ_NOTION_DATABASE_ID;

module.exports = {
  genAI,
  fileManager,
  notion,
  DATABASE_ID,
  ffmpeg
};
