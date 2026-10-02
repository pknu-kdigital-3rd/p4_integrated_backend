# 문서 수정 및 재생성

최종 문서는 상위 디렉터리의 두 DOCX 파일이다. 본문과 표는 Word에서 직접 수정할 수 있다.

- `assets/`: 문서에 삽입한 구조도와 학습·평가 그래프.
- `data/`: A0~A4 원본 학습 CSV 사본과 최고 Mask epoch 지표.
- `document_manifest.json`: 문서 구성과 장별 시작 페이지.
- `previews/`: Word로 내보낸 페이지 배치 검수용 PDF.
- `build_documents.py`: 본문·표·그림 생성 코드.

## 재생성

Python 환경에 `python-docx`, `matplotlib`, `Pillow`가 필요하다. 기본 모델 자료 경로는 `/dat/3rdgen_archive/project4/yolo_carafe_aspp`이다. 다른 위치를 사용할 때 `P4_MODEL_ARCHIVE`를 지정한다.

```sh
python3 docs/deliverables/source/build_documents.py
```

재생성하면 상위 디렉터리의 DOCX와 그림·CSV 사본을 다시 작성한다. Word에서 직접 수정한 내용은 재생성 전에 따로 보관하거나 생성 코드에 반영한다.

macOS의 Microsoft Word에서 목차·쪽번호를 갱신하고 PDF 검수본을 만들 때는 다음 스크립트를 사용한다.

```sh
osascript docs/deliverables/source/render_in_word.applescript \
  /Volumes/Ramdisk/p4_integrated_backend/docs/deliverables \
  /Volumes/Ramdisk/p4_integrated_backend/docs/deliverables/source/previews
```

학습 수치를 수정할 때 해당 실행의 CSV와 성능 표·본문 분석을 함께 갱신한다. A2와 A3는 개별 실험으로 작성되어 있으며 각 실행의 저장된 기록을 사용한다. UniDepth 상세 자료는 문서의 빈 표와 그림 영역에 입력한다.
