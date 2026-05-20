/**
 * OPPO 资源分类对照表。
 *
 * 来源：OPPO 开放平台文档《资源分类对照表》doc_id=11017。
 * 字段说明：id 为二级分类 ID，children[].id 为三级分类 ID。
 * 发布接口仍提交 second_category_id / third_category_id，前端只负责把人工输入改成下拉选择。
 */
export const OPPO_CATEGORIES = [
  {
    "id": 74,
    "name": "社交通讯",
    "primaryId": 7,
    "primaryName": "应用",
    "children": [
      {
        "id": 6654,
        "name": "电话短信"
      },
      {
        "id": 6685,
        "name": "婚恋"
      },
      {
        "id": 6686,
        "name": "社区"
      },
      {
        "id": 6808,
        "name": "聊天交友"
      },
      {
        "id": 8115,
        "name": "表情头像"
      }
    ]
  },
  {
    "id": 77,
    "name": "便捷生活",
    "primaryId": 7,
    "primaryName": "应用",
    "children": [
      {
        "id": 6689,
        "name": "美食外卖"
      },
      {
        "id": 6691,
        "name": "买房租房"
      },
      {
        "id": 6812,
        "name": "购票"
      },
      {
        "id": 6813,
        "name": "生活服务"
      },
      {
        "id": 8117,
        "name": "求职招聘"
      },
      {
        "id": 8118,
        "name": "汽车生活"
      }
    ]
  },
  {
    "id": 78,
    "name": "实用工具",
    "primaryId": 7,
    "primaryName": "应用",
    "children": [
      {
        "id": 6687,
        "name": "生活工具"
      },
      {
        "id": 6690,
        "name": "天气"
      },
      {
        "id": 6723,
        "name": "输入法"
      },
      {
        "id": 6724,
        "name": "浏览器"
      },
      {
        "id": 6784,
        "name": "WiFi"
      },
      {
        "id": 6785,
        "name": "手机美化"
      }
    ]
  },
  {
    "id": 79,
    "name": "资讯阅读",
    "primaryId": 7,
    "primaryName": "应用",
    "children": [
      {
        "id": 6664,
        "name": "漫画"
      },
      {
        "id": 6667,
        "name": "听书"
      },
      {
        "id": 6725,
        "name": "电子书"
      },
      {
        "id": 6814,
        "name": "资讯"
      },
      {
        "id": 6815,
        "name": "报纸杂志"
      },
      {
        "id": 8189,
        "name": "新闻"
      }
    ]
  },
  {
    "id": 80,
    "name": "系统优化",
    "primaryId": 7,
    "primaryName": "应用",
    "children": [
      {
        "id": 6671,
        "name": "手机安全"
      },
      {
        "id": 6672,
        "name": "省电"
      },
      {
        "id": 6673,
        "name": "流量"
      },
      {
        "id": 8121,
        "name": "垃圾清理"
      },
      {
        "id": 8122,
        "name": "文件管理"
      }
    ]
  },
  {
    "id": 460,
    "name": "拍摄美化",
    "primaryId": 7,
    "primaryName": "应用",
    "children": [
      {
        "id": 6680,
        "name": "相机"
      },
      {
        "id": 6681,
        "name": "照片美化"
      },
      {
        "id": 6810,
        "name": "相册图库"
      },
      {
        "id": 6811,
        "name": "拍视频"
      },
      {
        "id": 8116,
        "name": "图片社区"
      }
    ]
  },
  {
    "id": 462,
    "name": "医疗健康",
    "primaryId": 7,
    "primaryName": "应用",
    "children": [
      {
        "id": 6643,
        "name": "医疗"
      },
      {
        "id": 6644,
        "name": "经期"
      },
      {
        "id": 6645,
        "name": "运动健身"
      },
      {
        "id": 6646,
        "name": "健康"
      },
      {
        "id": 6647,
        "name": "怀孕"
      }
    ]
  },
  {
    "id": 463,
    "name": "金融理财",
    "primaryId": 7,
    "primaryName": "应用",
    "children": [
      {
        "id": 6648,
        "name": "银行"
      },
      {
        "id": 6649,
        "name": "投资理财"
      },
      {
        "id": 6651,
        "name": "记账"
      },
      {
        "id": 6652,
        "name": "支付"
      },
      {
        "id": 8114,
        "name": "贷款"
      }
    ]
  },
  {
    "id": 465,
    "name": "办公软件",
    "primaryId": 7,
    "primaryName": "应用",
    "children": [
      {
        "id": 6659,
        "name": "笔记"
      },
      {
        "id": 6660,
        "name": "办公"
      },
      {
        "id": 6661,
        "name": "文档"
      },
      {
        "id": 6663,
        "name": "存储"
      },
      {
        "id": 6781,
        "name": "邮箱"
      },
      {
        "id": 6782,
        "name": "效率"
      }
    ]
  },
  {
    "id": 6761,
    "name": "教育学习",
    "primaryId": 7,
    "primaryName": "应用",
    "children": [
      {
        "id": 6666,
        "name": "语言学习"
      },
      {
        "id": 6668,
        "name": "词典翻译"
      },
      {
        "id": 6669,
        "name": "驾考"
      },
      {
        "id": 6670,
        "name": "儿童教育"
      },
      {
        "id": 6783,
        "name": "在线教育"
      },
      {
        "id": 8165,
        "name": "职业培训"
      }
    ]
  },
  {
    "id": 6762,
    "name": "网上购物",
    "primaryId": 7,
    "primaryName": "应用",
    "children": [
      {
        "id": 6692,
        "name": "商城"
      },
      {
        "id": 6694,
        "name": "团购"
      },
      {
        "id": 6767,
        "name": "折扣"
      },
      {
        "id": 6768,
        "name": "海淘"
      },
      {
        "id": 8119,
        "name": "快递"
      },
      {
        "id": 8163,
        "name": "二手买卖"
      }
    ]
  },
  {
    "id": 6786,
    "name": "视频播放",
    "primaryId": 7,
    "primaryName": "应用",
    "children": [
      {
        "id": 6787,
        "name": "在线视频"
      },
      {
        "id": 6788,
        "name": "游戏直播"
      },
      {
        "id": 6789,
        "name": "真人秀"
      },
      {
        "id": 6790,
        "name": "短视频"
      },
      {
        "id": 6791,
        "name": "播放器"
      },
      {
        "id": 8123,
        "name": "体育直播"
      }
    ]
  },
  {
    "id": 6792,
    "name": "音乐电台",
    "primaryId": 7,
    "primaryName": "应用",
    "children": [
      {
        "id": 6793,
        "name": "在线音乐"
      },
      {
        "id": 6794,
        "name": "K歌"
      },
      {
        "id": 6805,
        "name": "乐器"
      },
      {
        "id": 6806,
        "name": "电台"
      },
      {
        "id": 6807,
        "name": "铃声"
      }
    ]
  },
  {
    "id": 6795,
    "name": "交通导航",
    "primaryId": 7,
    "primaryName": "应用",
    "children": [
      {
        "id": 6801,
        "name": "打车租车"
      },
      {
        "id": 6802,
        "name": "公交地铁"
      },
      {
        "id": 6803,
        "name": "火车票"
      },
      {
        "id": 6804,
        "name": "地图导航"
      },
      {
        "id": 8166,
        "name": "交通违章"
      },
      {
        "id": 8167,
        "name": "单车"
      }
    ]
  },
  {
    "id": 6796,
    "name": "旅游出行",
    "primaryId": 7,
    "primaryName": "应用",
    "children": [
      {
        "id": 6797,
        "name": "机票酒店"
      },
      {
        "id": 6798,
        "name": "攻略"
      },
      {
        "id": 6799,
        "name": "周边游"
      }
    ]
  },
  {
    "id": 6878,
    "name": "生活娱乐",
    "primaryId": 7,
    "primaryName": "应用",
    "children": [
      {
        "id": 6879,
        "name": "搞笑段子"
      },
      {
        "id": 6880,
        "name": "星座八字"
      },
      {
        "id": 6881,
        "name": "搞怪"
      },
      {
        "id": 8170,
        "name": "游戏助手"
      }
    ]
  },
  {
    "id": 8192,
    "name": "人工智能",
    "primaryId": 7,
    "primaryName": "应用",
    "children": [
      {
        "id": 8193,
        "name": "AI办公"
      },
      {
        "id": 8194,
        "name": "AI影像"
      },
      {
        "id": 8195,
        "name": "AI学习"
      },
      {
        "id": 8196,
        "name": "AI生活"
      },
      {
        "id": 8197,
        "name": "AI医疗"
      },
      {
        "id": 8198,
        "name": "AI社交"
      },
      {
        "id": 8199,
        "name": "融合AI"
      }
    ]
  },
  {
    "id": 81,
    "name": "休闲益智",
    "primaryId": 8,
    "primaryName": "游戏",
    "children": [
      {
        "id": 6696,
        "name": "解谜"
      },
      {
        "id": 6697,
        "name": "益智"
      },
      {
        "id": 6844,
        "name": "消除"
      },
      {
        "id": 8134,
        "name": "快速反应"
      },
      {
        "id": 8135,
        "name": "休闲竞技"
      }
    ]
  },
  {
    "id": 82,
    "name": "棋牌游戏",
    "primaryId": 8,
    "primaryName": "游戏",
    "children": [
      {
        "id": 6705,
        "name": "棋类"
      },
      {
        "id": 6706,
        "name": "麻将"
      },
      {
        "id": 6707,
        "name": "桌游"
      },
      {
        "id": 6708,
        "name": "纸牌"
      },
      {
        "id": 6841,
        "name": "斗地主"
      }
    ]
  },
  {
    "id": 84,
    "name": "体育竞速",
    "primaryId": 8,
    "primaryName": "游戏",
    "children": [
      {
        "id": 6728,
        "name": "赛车"
      },
      {
        "id": 6875,
        "name": "足球"
      },
      {
        "id": 6877,
        "name": "运动"
      },
      {
        "id": 8141,
        "name": "篮球"
      },
      {
        "id": 8142,
        "name": "竞速"
      }
    ]
  },
  {
    "id": 85,
    "name": "角色扮演",
    "primaryId": 8,
    "primaryName": "游戏",
    "children": [
      {
        "id": 6714,
        "name": "回合制"
      },
      {
        "id": 8146,
        "name": "传奇"
      },
      {
        "id": 8147,
        "name": "挂机"
      },
      {
        "id": 8155,
        "name": "卡牌"
      },
      {
        "id": 8156,
        "name": "动作"
      },
      {
        "id": 8157,
        "name": "多人在线"
      }
    ]
  },
  {
    "id": 469,
    "name": "动作冒险",
    "primaryId": 8,
    "primaryName": "游戏",
    "children": [
      {
        "id": 6701,
        "name": "跑酷"
      },
      {
        "id": 6729,
        "name": "冒险"
      },
      {
        "id": 8136,
        "name": "闯关"
      },
      {
        "id": 8150,
        "name": "横版格斗"
      }
    ]
  },
  {
    "id": 8126,
    "name": "特色分类",
    "primaryId": 8,
    "primaryName": "游戏",
    "children": [
      {
        "id": 8127,
        "name": "女性向"
      },
      {
        "id": 8128,
        "name": "二次元"
      },
      {
        "id": 8184,
        "name": "创造生存"
      },
      {
        "id": 8185,
        "name": "独立游戏"
      },
      {
        "id": 8186,
        "name": "地方棋牌"
      },
      {
        "id": 8187,
        "name": "小包游戏"
      }
    ]
  },
  {
    "id": 8137,
    "name": "射击游戏",
    "primaryId": 8,
    "primaryName": "游戏",
    "children": [
      {
        "id": 8138,
        "name": "第三人称"
      },
      {
        "id": 8139,
        "name": "横版射击"
      },
      {
        "id": 8140,
        "name": "吃鸡"
      },
      {
        "id": 8151,
        "name": "第一人称"
      },
      {
        "id": 8152,
        "name": "飞机坦克"
      }
    ]
  },
  {
    "id": 8143,
    "name": "经营策略",
    "primaryId": 8,
    "primaryName": "游戏",
    "children": [
      {
        "id": 8144,
        "name": "换装"
      },
      {
        "id": 8145,
        "name": "MOBA"
      },
      {
        "id": 8153,
        "name": "战争策略"
      },
      {
        "id": 8154,
        "name": "塔防"
      },
      {
        "id": 8159,
        "name": "经营"
      },
      {
        "id": 8160,
        "name": "养成"
      }
    ]
  },
  {
    "id": 8148,
    "name": "音乐舞蹈",
    "primaryId": 8,
    "primaryName": "游戏",
    "children": [
      {
        "id": 8149,
        "name": "舞蹈"
      },
      {
        "id": 8158,
        "name": "音乐节奏"
      }
    ]
  }
];
