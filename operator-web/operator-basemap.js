const STYLE_URL='https://tiles.openfreemap.org/styles/liberty';

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
    layer=L.maplibreGL({style:STYLE_URL}).addTo(map);
    const glMap=layer.getMaplibreMap();
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
