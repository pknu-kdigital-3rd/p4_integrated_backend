const STATUS_LABELS={FINALIZED:'저장 완료',FAILED:'실패'};
const TRIP_LABELS={READY:'대기',IN_PROGRESS:'운행 중',PAUSED:'일시 정지',COMPLETED:'완료',CANCELLED:'취소'};

export function recordingSize(value){
  const bytes=Number(value)||0;
  if(bytes>=1024**3)return `${(bytes/1024**3).toFixed(1)} GB`;
  if(bytes>=1024**2)return `${(bytes/1024**2).toFixed(1)} MB`;
  return `${Math.ceil(bytes/1024)} KB`;
}
export function recordingDuration(value){
  const seconds=Math.max(0,Math.floor(Number(value)||0));
  return `${Math.floor(seconds/3600)}:${String(Math.floor(seconds/60)%60).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;
}
export function recordingStatus(summary){
  return Object.entries(summary.recordingStatuses||{}).map(([status,count])=>`${STATUS_LABELS[status]||status} ${count}`).join(' · ');
}

// Explicit bounded batches preserve the selected snapshot even if recording
// continues while deletion is underway. Never ask the server to delete a prefix.
export async function deleteRecordingSnapshot(api,tripId,videos){
  const snapshot=videos.map(video=>String(video.tripVideoId));
  const deletedTripVideoIds=[],failures=[];
  for(let index=0;index<snapshot.length;index+=50){
    const tripVideoIds=snapshot.slice(index,index+50);
    try{
      const result=await api(`/api/v1/trips/${encodeURIComponent(tripId)}/videos`,{method:'DELETE',body:JSON.stringify({tripVideoIds})},true);
      deletedTripVideoIds.push(...result.deletedTripVideoIds);
      failures.push(...result.failures);
    }catch(error){
      failures.push(...tripVideoIds.map(tripVideoId=>({tripVideoId,message:error.message})));
    }
  }
  return {deletedTripVideoIds,failures};
}

export function mountRecordingManagement(root,{api,canManage,onOpenTrip,onChanged}){
  const make=(tag,text,className)=>{const element=document.createElement(tag);if(text)element.textContent=text;if(className)element.className=className;return element};
  const toolbar=make('div',null,'recording-library-toolbar'),refreshButton=make('button','새로고침'),status=make('p'),list=make('div',null,'recording-library-list'),more=make('button','이전 운행 더 보기'),detail=make('div',null,'recording-library-detail');
  refreshButton.type=more.type='button';status.setAttribute('role','status');more.hidden=true;detail.hidden=true;
  toolbar.append(refreshButton);root.replaceChildren(toolbar,status,list,more,detail);
  let trips=[],cursor=null,listGeneration=0,detailGeneration=0,selectedTripId='',busy=false;
  function render(){
    list.replaceChildren();
    for(const trip of trips){
      const row=make('div',null,'recording-library-row'),info=make('div'),title=make('strong',`운행 ${trip.tripId} · ${trip.vehicleCode}`),summary=make('p',`${trip.segmentCount}개 구간 · ${recordingDuration(trip.durationSec)} · ${recordingSize(trip.sizeBytes)}`),state=make('p',recordingStatus(trip)),open=make('button','녹화 보기');
      const destination=make('p',`${TRIP_LABELS[trip.tripStatus]||trip.tripStatus} · ${trip.destinationName}`);
      info.append(title,destination,summary,state);open.type='button';open.disabled=busy;open.setAttribute('aria-label',`운행 ${trip.tripId} 녹화 보기`);open.addEventListener('click',()=>void selectTrip(trip));row.append(info,open);list.append(row);
    }
    more.hidden=!cursor;more.disabled=busy;
  }
  async function refresh(append=false){
    if(busy)return;
    const generation=++listGeneration;
    refreshButton.disabled=more.disabled=true;status.textContent='운행별 녹화 불러오는 중…';
    try{
      const result=await api(`/api/v1/recording-trips${append&&cursor?`?beforeTripId=${encodeURIComponent(cursor)}`:''}`,{},true);
      if(generation!==listGeneration)return;
      trips=append?[...trips,...result.trips]:result.trips;cursor=result.nextBeforeTripId;render();
      status.textContent=trips.length?`${trips.length}개 운행 · 저장된 구간만 재생·다운로드·삭제할 수 있습니다.`:'저장된 녹화가 있는 운행이 없습니다.';
    }catch(error){if(generation===listGeneration)status.textContent=error.message}
    finally{if(generation===listGeneration){refreshButton.disabled=false;more.disabled=false}}
  }
  async function selectTrip(trip,play=false){
    if(busy)return;
    const generation=++detailGeneration;selectedTripId=String(trip.tripId);detail.hidden=false;detail.replaceChildren(make('p',`운행 ${trip.tripId} 녹화 불러오는 중…`));
    try{
      const videos=await api(`/api/v1/trips/${encodeURIComponent(trip.tripId)}/videos`,{},true);
      if(generation!==detailGeneration)return;
      const heading=make('h3',`운행 ${trip.tripId} · 저장 완료 ${videos.length}개`),actions=make('div',null,'recording-library-toolbar'),replay=make('button','운행 재생'),message=make('p'),segments=make('div',null,'recording-library-segments');
      message.setAttribute('role','status');replay.type='button';replay.disabled=!videos.length;replay.addEventListener('click',()=>onOpenTrip(String(trip.tripId)));actions.append(replay);
      if(canManage()&&videos.length){
        const remove=make('button','운행 녹화 전체 삭제','recording-library-delete');remove.type='button';actions.append(remove);
        remove.addEventListener('click',async()=>{
          if(busy||!canManage()||!window.confirm(`운행 ${trip.tripId}의 저장된 녹화 ${videos.length}개와 해당 재생 감지 데이터를 영구 삭제하시겠습니까? 운행·GPS 기록은 유지되며, 이후 추가되는 녹화는 삭제하지 않습니다.`))return;
          busy=true;refreshButton.disabled=true;remove.disabled=replay.disabled=true;render();message.textContent='녹화 삭제 중…';
          const result=await deleteRecordingSnapshot(api,trip.tripId,videos);
          busy=false;refreshButton.disabled=false;
          // The old snapshot must not remain actionable after partial deletion.
          await refresh();await selectTrip(trip);
          try{await onChanged(String(trip.tripId))}catch(error){console.warn('Could not refresh trip playback after deletion',error)}
          status.textContent=result.failures.length?`${result.deletedTripVideoIds.length}개 삭제 · ${result.failures.length}개 실패: ${result.failures[0].message}`:`운행 ${trip.tripId}: 녹화 ${result.deletedTripVideoIds.length}개 삭제 완료.`;
        });
      }
      for(const video of videos){
        const row=make('div',null,'recording-library-row'),label=make('span',`${new Date(video.startedAt).toLocaleString('ko-KR')} · 구간 ${video.segmentIndex} · ${recordingDuration(video.durationSec)} · ${recordingSize(video.sizeBytes)}`),download=make('button','다운로드');download.type='button';
        download.addEventListener('click',async()=>{
          if(busy)return;
          download.disabled=true;
          try{
            const result=await api(`/api/v1/trip-videos/${encodeURIComponent(video.tripVideoId)}/download-url`,{method:'POST'},true);
            const link=make('a');link.href=result.url;link.download=`trip-${trip.tripId}-segment-${video.tripVideoId}.mp4`;link.hidden=true;document.body.append(link);link.click();link.remove();
            if(generation===detailGeneration)message.textContent='선택한 녹화 구간 다운로드를 시작했습니다.';
          }catch(error){if(generation===detailGeneration)message.textContent=error.message}
          finally{download.disabled=false}
        });
        row.append(label,download);segments.append(row);
      }
      detail.replaceChildren(heading,actions,message,segments);
      if(!videos.length)message.textContent='재생 가능한 저장 완료 구간이 없습니다.';
      if(play&&videos.length)onOpenTrip(String(trip.tripId));
    }catch(error){if(generation===detailGeneration)detail.replaceChildren(make('p',error.message))}
  }
  refreshButton.addEventListener('click',()=>void refresh());more.addEventListener('click',()=>void refresh(true));
  return {refresh,async changed(tripId){await refresh();if(selectedTripId===String(tripId)){const trip=trips.find(item=>String(item.tripId)===selectedTripId);if(trip)await selectTrip(trip);else{detailGeneration++;detail.hidden=true;selectedTripId=''}}}};
}
