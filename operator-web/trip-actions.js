import {deleteRecordingSnapshot} from './recording-delete.js?v=1';

export function tripAction(status,role){
  if(!['ADMIN','OPERATOR'].includes(role))return null;
  if(['READY','IN_PROGRESS','PAUSED'].includes(status))return 'cancel';
  if(['COMPLETED','CANCELLED'].includes(status))return 'delete';
  return null;
}

export async function deleteTripWithRecordings(api,tripId,confirm,beforeDelete=()=>{}){
  const id=encodeURIComponent(tripId),videos=await api(`/api/v1/trips/${id}/videos`,{},true);
  if(!confirm(`운행 ${tripId}을(를) 영구 삭제하시겠습니까?\n저장된 녹화 ${videos.length}개, 경로·이탈 기록, 운행·이탈 경보 및 재생 감지 데이터가 삭제됩니다.\n차량, GPS·객체 감지 기록과 운송 목표는 유지되며 운행 연결만 해제됩니다. 이 작업은 되돌릴 수 없습니다.`))return false;
  beforeDelete();
  if(videos.length){
    const result=await deleteRecordingSnapshot(api,tripId,videos);
    if(result.failures.length)throw new Error(`녹화 ${result.deletedTripVideoIds.length}개 삭제 · ${result.failures.length}개 실패: ${result.failures[0].message}. 운행 항목은 유지됩니다. 남은 녹화 삭제 후 다시 시도하세요.`);
  }
  await api(`/api/v1/trips/${id}`,{method:'DELETE'},true);
  return true;
}
