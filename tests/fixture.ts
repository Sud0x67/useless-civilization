import { IDS, type Round } from '../src/shared/schema';
export const round: Round = {
  decisions: IDS.map((agentId, i) => ({
    agentId,
    action: i === 2 ? 'work' : 'socialize',
    location: i === 2 ? 'farm' : 'square',
    speech: [
      '我提议先去广场听听大家的想法。',
      '今天的面包可以接受夸奖付款。',
      '先收完这片小麦，再去看星星。',
      '我可以造一台会鼓掌的机器。',
      '这场雨，应该装进诗里。',
      '如果发呆也是工作，我已经加班了。',
    ][i],
    reason: [
      '去广场交流',
      '寻找新的顾客',
      '收获面包小麦',
      '讨论机器设计',
      '向大家分享诗句',
      '在广场思考人生',
    ][i],
    target: IDS[(i + 1) % 6],
    intent: 'praise',
  })),
};
export const decision = {
  action: 'socialize',
  location: 'square',
  speech: '谢谢你来星落镇。我们一起去看星星吧。',
  reason: '邀请人类一起看星星',
};
