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
