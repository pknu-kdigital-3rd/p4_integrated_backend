const BASEMAP_ROOT=new URL('/basemap/',import.meta.url).href;
const ASSET_ROOT=new URL('/basemap-assets/',import.meta.url).href;
const STYLE_URL=`${BASEMAP_ROOT}styles/liberty`;
const TILE_ORIGIN='https://tiles.openfreemap.org/';
const ASSET_ORIGIN='https://assets.openfreemap.com/';

// Keep these colors separate so map features remain distinct at every zoom.
export const OPERATOR_MAP_COLORS={
  land:'#F7F8F4',
  water:'#B9DDF5',
  park:'#CFE8D2',
  localRoad:'#FFFFFF',
  localRoadEdge:'#E4E8E6',
  majorRoad:'#E8D9BB',
  majorRoadEdge:'#D8CCB5',
  building:'#E8EAE7',
  label:'#34465A',
};

function colorOperatorLayers(glMap){
  for(const layer of glMap.getStyle().layers){
    const id=layer.id.toLowerCase();
    const sourceLayer=String(layer['source-layer']||'').toLowerCase();
    if(layer.type==='background'){
      glMap.setPaintProperty(layer.id,'background-color',OPERATOR_MAP_COLORS.land);
    }else if(layer.type==='fill'){
      if(sourceLayer==='water'||id.includes('water'))glMap.setPaintProperty(layer.id,'fill-color',OPERATOR_MAP_COLORS.water);
      else if(sourceLayer==='park'||/park|garden|grass|forest|wood|nature|recreation/.test(id))glMap.setPaintProperty(layer.id,'fill-color',OPERATOR_MAP_COLORS.park);
      else if(id.includes('building'))glMap.setPaintProperty(layer.id,'fill-color',OPERATOR_MAP_COLORS.building);
    }else if(layer.type==='line'){
      if(sourceLayer==='waterway'||id.includes('water'))glMap.setPaintProperty(layer.id,'line-color',OPERATOR_MAP_COLORS.water);
      else if(/road|highway|motorway|trunk|primary|secondary|tertiary|street|bridge|tunnel/.test(id)&&!id.includes('rail')){
        const major=/motorway|trunk|primary|secondary/.test(id);
        const casing=/casing|outline|border/.test(id);
        glMap.setPaintProperty(layer.id,'line-color',major
          ? casing?OPERATOR_MAP_COLORS.majorRoadEdge:OPERATOR_MAP_COLORS.majorRoad
          : casing?OPERATOR_MAP_COLORS.localRoadEdge:OPERATOR_MAP_COLORS.localRoad);
      }
    }else if(layer.type==='symbol'&&layer.layout?.['text-field']){
      glMap.setPaintProperty(layer.id,'text-color',OPERATOR_MAP_COLORS.label);
      glMap.setPaintProperty(layer.id,'text-halo-color','#FFFFFF');
    }
  }
}

export function installOperatorBasemap(map,fallback,initialStyle='operator'){
  let layer=null,generation=0,currentStyle=null;
  const useFallback=()=>{if(!map.hasLayer(fallback))fallback.addTo(map)};
  const setStyle=style=>{
    const next=style==='default'?'default':'operator';
    if(next===currentStyle)return;
    currentStyle=next;
    const request=++generation;
    if(layer){if(map.hasLayer(layer))map.removeLayer(layer);layer=null}
    useFallback();
    if(next==='default')return;
    if(typeof L.maplibreGL!=='function')return;
    try{
      // Keep the WebGL basemap below Leaflet routes and vehicle markers.
      const pane=map.getPane('operatorBasemapPane')||map.createPane('operatorBasemapPane');
      pane.style.zIndex='100';
      pane.style.pointerEvents='none';
      const candidate=L.maplibreGL({
        pane:'operatorBasemapPane',
        style:STYLE_URL,
        transformRequest:url=>({url:url.startsWith(TILE_ORIGIN)?`${BASEMAP_ROOT}${url.slice(TILE_ORIGIN.length)}`
          :url.startsWith(ASSET_ORIGIN)?`${ASSET_ROOT}${url.slice(ASSET_ORIGIN.length)}`:url}),
      }).addTo(map);
      layer=candidate;
      const glMap=candidate.getMaplibreMap();
      const emptyIcon={width:1,height:1,data:new Uint8Array(4)};
      glMap.on('styleimagemissing',({id})=>{
        if(request===generation&&id&&!glMap.hasImage(id))glMap.addImage(id,emptyIcon);
      });
      const failed=event=>{
        if(request!==generation)return;
        if(map.hasLayer(candidate))map.removeLayer(candidate);
        if(layer===candidate)layer=null;
        useFallback();
        console.warn('Operator vector basemap unavailable; using OSM tiles.',event?.error||event);
      };
      glMap.once('error',failed);
      glMap.once('load',()=>{
        if(request!==generation)return;
        glMap.off('error',failed);
        try{colorOperatorLayers(glMap);map.removeLayer(fallback)}catch(error){failed({error})}
      });
    }catch(error){
      if(request===generation){if(layer&&map.hasLayer(layer))map.removeLayer(layer);layer=null;useFallback()}
      console.warn('Operator vector basemap unavailable; using OSM tiles.',error);
    }
  };
  setStyle(initialStyle);
  return setStyle;
}
