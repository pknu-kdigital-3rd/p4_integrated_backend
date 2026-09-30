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
  localRoadEdge:'#D6DEE2',
  majorRoad:'#F3CE85',
  majorRoadEdge:'#D7B66F',
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

export function installOperatorBasemap(map,fallback){
  if(typeof L.maplibreGL!=='function')return;
  let layer;
  try{
    // A separate lower pane guarantees WebGL tiles cannot cover Leaflet's
    // routes, vehicles, labels, or controls, regardless of plugin CSS.
    const pane=map.createPane('operatorBasemapPane');
    pane.style.zIndex='100';
    pane.style.pointerEvents='none';
    layer=L.maplibreGL({
      pane:'operatorBasemapPane',
      style:STYLE_URL,
      transformRequest:url=>({url:url.startsWith(TILE_ORIGIN)?`${BASEMAP_ROOT}${url.slice(TILE_ORIGIN.length)}`
        :url.startsWith(ASSET_ORIGIN)?`${ASSET_ROOT}${url.slice(ASSET_ORIGIN.length)}`:url}),
    }).addTo(map);
    const glMap=layer.getMaplibreMap();
    // The upstream style references a few POI sprites that it does not ship.
    // Resolve only those missing basemap images with a transparent pixel; bus
    // markers are Leaflet HTML icons and are unaffected.
    const emptyIcon={width:1,height:1,data:new Uint8Array(4)};
    glMap.on('styleimagemissing',({id})=>{
      if(id&&!glMap.hasImage(id))glMap.addImage(id,emptyIcon);
    });
    const useFallback=event=>{
      if(map.hasLayer(layer))map.removeLayer(layer);
      console.warn('Operator vector basemap unavailable; using OSM tiles.',event?.error||event);
    };
    glMap.once('error',useFallback);
    glMap.once('load',()=>{
      glMap.off('error',useFallback);
      try{
        colorOperatorLayers(glMap);
        map.removeLayer(fallback);
      }catch(error){useFallback({error})}
    });
  }catch(error){
    if(layer&&map.hasLayer(layer))map.removeLayer(layer);
    console.warn('Operator vector basemap unavailable; using OSM tiles.',error);
  }
}
