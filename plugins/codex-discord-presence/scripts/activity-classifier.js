'use strict';

// 從 Codex 對話紀錄尾端的 JSONL 內容推斷目前的活動狀態。
function classifyActivity(text) {
  for (const value of String(text).split(/\r?\n/).reverse()) {
    try {
      const record = JSON.parse(value);
      const type = `${record.type || ''}/${record.payload?.type || ''}/${record.payload?.role || ''}`;
      if (/patch_apply_end/.test(type)) return 'Editing';
      if (/function_call_output|custom_tool_call_output/.test(type)) return 'Reading results';
      if (/function_call|custom_tool_call/.test(type)) return 'Running tools';
      if (/reasoning|task_started|agent_reasoning/.test(type)) return 'Thinking';
      if (/task_complete|agent_message/.test(type)) return 'Waiting';
    } catch {
      // 略過不完整或無法辨識的紀錄。
    }
  }
  return 'Working';
}

module.exports = { classifyActivity };
