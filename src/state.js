module.exports = {
  isRecording: false,
  activeStreams: new Map(),
  userNames: new Map(), // userId -> displayName 캐시
  currentMeetingParticipants: new Set(), // 현재 회의 참여자 목록
  lastSummary: "", // 마지막으로 생성된 요약본 저장
  lastParticipants: [], // 마지막 회의 참여자 목록 저장
  lastFailedMeeting: null // 실패한 회의 정보 (audioPath, participants)
};
