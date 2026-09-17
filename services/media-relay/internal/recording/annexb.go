package recording

import (
	"errors"
)

var errInvalidAnnexB = errors.New("invalid Annex-B H.264 access unit")

func parseAnnexBNALUs(accessUnit []byte) ([][]byte, error) {
	first, prefix := findStartCode(accessUnit, 0)
	if first < 0 {
		return nil, errInvalidAnnexB
	}
	for _, value := range accessUnit[:first] {
		if value != 0 {
			return nil, errInvalidAnnexB
		}
	}

	var nalus [][]byte
	for start := first + prefix; start <= len(accessUnit); {
		next, nextPrefix := findStartCode(accessUnit, start)
		end := len(accessUnit)
		if next >= 0 {
			end = next
		}
		for end > start && accessUnit[end-1] == 0 {
			end--
		}
		if end > start {
			nalus = append(nalus, accessUnit[start:end])
		}
		if next < 0 {
			break
		}
		start = next + nextPrefix
	}
	if len(nalus) == 0 {
		return nil, errInvalidAnnexB
	}
	return nalus, nil
}

func findStartCode(data []byte, from int) (int, int) {
	for i := from; i+3 <= len(data); i++ {
		if i+4 <= len(data) && data[i] == 0 && data[i+1] == 0 && data[i+2] == 0 && data[i+3] == 1 {
			return i, 4
		}
		if data[i] == 0 && data[i+1] == 0 && data[i+2] == 1 {
			return i, 3
		}
	}
	return -1, 0
}

func h264Parameters(nalus [][]byte) (sps []byte, pps []byte, hasIDR bool) {
	for _, nalu := range nalus {
		if len(nalu) == 0 {
			continue
		}
		switch nalu[0] & 0x1f {
		case 5:
			hasIDR = true
		case 7:
			if sps == nil {
				sps = nalu
			}
		case 8:
			if pps == nil {
				pps = nalu
			}
		}
	}
	return sps, pps, hasIDR
}
