// Korean names for the enum codes that appear in the assistant's live context.
//
// The LLM used to translate raw codes itself and got them wrong (vehicle
// READY reported as "중지", i.e. stopped). Every code is now rendered as
// "<Korean name>(<CODE>)" with the operator UI's wording, so the model can
// copy the name instead of guessing. Unknown codes are left as they are.

export type LabelMap = Readonly<Record<string, string>>;

// vehicle.vehicle_status
export const VEHICLE_STATUS_LABELS: LabelMap = {
    READY: "대기", DRIVING: "운행중", STOPPED: "정차", MAINTENANCE: "점검", OFFLINE: "오프라인",
};

// trip.trip_status (operator-web TRIP_STATUS_LABELS)
export const TRIP_STATUS_LABELS: LabelMap = {
    READY: "출발 대기", IN_PROGRESS: "운행 중", PAUSED: "일시정지", COMPLETED: "완료", CANCELLED: "취소",
};

// virtual_vehicle_state.sim_status and virtual_trip.state
export const SIM_STATUS_LABELS: LabelMap = {
    DRIVING: "주행 중",
    PAUSED: "일시정지",
    REROUTING: "경로 재계산 중",
    BLOCKED_AWAITING_OPERATOR: "통제 구간 앞 정지, 관제 조치 대기",
    NO_ROUTE: "경로 없음",
    COMPLETED: "도착 완료",
    CANCELLED: "운행 취소",
};

export const SCENARIO_STATE_LABELS: LabelMap = { ACTIVE: "진행 중", ARCHIVED: "보관됨" };

export const VEHICLE_SOURCE_LABELS: LabelMap = { BIMS: "버스 정보 시스템", CUSTOM: "자체 등록", VIRTUAL: "가상" };

export const TELEMETRY_SOURCE_LABELS: LabelMap = {
    BIMS_LIVE: "BIMS 실시간", BIMS_REPLAY: "BIMS 재생", DEVICE_GPS: "단말 GPS", RECORDED_GPS: "녹화 GPS 재생",
};

export const RISK_LABELS: LabelMap = { NORMAL: "정상", CAUTION: "주의", DANGER: "위험" };

export const SEVERITY_LABELS: LabelMap = { INFO: "정보", WARNING: "경고", CRITICAL: "심각" };

export const ALERT_TYPE_LABELS: LabelMap = {
    OBJECT_PROXIMITY: "객체 근접", ROUTE_DEVIATION: "경로 이탈", TRIP_COMPLETED: "운행 완료",
};

// YOLO class names (COCO); detection rows also carry a display_name.
export const OBJECT_CLASS_LABELS: LabelMap = {
    person: "보행자", bicycle: "자전거", car: "승용차", motorcycle: "오토바이", bus: "버스", truck: "트럭",
};

// virtual_operator_event.event_type
export const EVENT_TYPE_LABELS: LabelMap = {
    DISPATCH_REQUEST_CREATED: "배차 요청 생성",
    DISPATCH_ACCEPTED: "배차 수락",
    DISPATCH_REJECTED: "배차 거절",
    ROAD_RESTRICTION_ACTIVATED: "도로 통제 시작",
    ROAD_RESTRICTION_UPDATED: "도로 통제 변경",
    ROAD_RESTRICTION_DEACTIVATED: "도로 통제 해제",
    ROAD_RESTRICTION_PAINTED: "도로 통제 지정",
    ROAD_RESTRICTION_ERASED: "도로 통제 삭제",
    ROAD_REOPENED: "도로 재개통",
    ROUTE_RECALCULATED: "경로 재계산",
    VEHICLE_BLOCKED_BY_RESTRICTION: "통제 구간으로 차량 정지",
    WAYPOINTS_REPLACED: "경유지 변경",
    SPEED_CHANGED: "속도 변경",
    SPEED_FACTOR_CHANGED: "속도 배율 변경",
    TURBO_MODE_CHANGED: "가속 모드 변경",
    TRIP_PAUSED: "운행 일시정지",
    TRIP_RESUMED: "운행 재개",
    TRIP_CANCELLED: "운행 취소",
    SCENARIO_ARCHIVED: "시나리오 보관",
};

// virtual_vehicle_state.blocked_reason is stored in English.
export const BLOCKED_REASON_LABELS: LabelMap = {
    "Blocked road ahead": "앞쪽 도로가 통제됨",
    "No legal route under the current road state": "현재 도로 상태에서 갈 수 있는 경로 없음",
    "No viable path after road restriction": "도로 통제 후 우회 경로 없음",
    "Routing failed after road-state change": "도로 상태 변경 후 경로 계산 실패",
};

export function label(code: string, labels: LabelMap): string {
    const name = labels[code];
    return name ? `${name}(${code})` : code;
}

// Free text such as blockedReason: just the Korean, the English adds nothing.
export function reasonText(reason: string, labels: LabelMap = BLOCKED_REASON_LABELS): string {
    return labels[reason] ?? reason;
}
