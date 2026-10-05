// Scripted UI demonstration, with no WebSocket or model connection.
export function createDemoAssistantConnection({onEvent}) {
  let generation=0;
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  return {
    async send(message) {
      const current=++generation;
      const {requestId}=message;
      onEvent({type:'start',requestId,snapshotAt:new Date().toISOString()});
      onEvent({type:'meta',requestId,sources:[],model:'발표용 스크립트 (AI 모델 아님)'});
      const text=String(message.question || message.message || '');
      const answer=/안전|위험|safety|점검/i.test(text)
        ? '**발표용 예시 응답**\n\n- 출발 전 차량 상태를 점검합니다.\n- 보행자와 충분한 거리를 유지합니다.\n- 위험 상황은 관제 담당자에게 전달합니다.\n\n이 답변은 미리 작성한 UI 예시이며 실제 AI 분석이나 안전 판단을 수행하지 않습니다.'
        : '**발표용 차량 현황**\n\n| 상태 | 차량 수 |\n| --- | --- |\n| 운행 중 | 4 |\n| 대기 | 2 |\n| 점검 | 1 |\n| 오프라인 | 1 |\n\n발표용 영상 차량을 선택하면 모의 탐지 화면을 볼 수 있습니다.\n\n이 답변은 고정된 샘플 데이터로 작성한 스크립트입니다. 실제 AI 모델이나 외부 API를 사용하지 않습니다.';
      for(const chunk of answer.match(/.{1,18}|\n/g)) {
        await wait(35);
        if(current!==generation) return;
        onEvent({type:'delta',requestId,text:chunk});
      }
      onEvent({type:'done',requestId});
    },
    abort(){generation++;},
  };
}
