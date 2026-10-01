# Cardlog — Pokémon TCG Explorer

TCGdex의 카드팩·카드 카탈로그를 불러오는 반응형 웹 앱입니다. 카드 정보와 가격 정보의 출처를 분리해 표시하고, 가격 공급자가 연결되지 않으면 가격을 임의로 만들지 않고 `가격 정보 없음`으로 표시합니다.

## 실행

필수 조건은 Node.js 18 이상입니다. 의존성 설치 없이 실행할 수 있습니다.

```bash
npm start
```

브라우저에서 `http://localhost:3000`을 엽니다. TCGdex API에 연결할 수 있어야 카드팩 목록이 표시됩니다. `.env.example`의 설정은 기본값과 같으므로 별도 설정 없이 시작할 수 있습니다. 환경 변수를 바꾸는 경우 현재 터미널 세션에 설정한 뒤 `npm start`를 실행하거나, 배포 플랫폼의 환경 변수 설정을 이용하세요.

예: PowerShell

```powershell
$env:PRICE_API_URL = 'https://your-price-service.example/api/prices'
$env:PRICE_API_KEY = 'your-secret-key'
npm start
```

## 데이터 출처와 한계

### 카드팩과 카드 정보 — TCGdex

- API: `https://api.tcgdex.net/v2/ko/sets`, `/sets/{id}`, `/cards/{id}`
- 이 프로젝트의 기본 API base: `https://api.tcgdex.net/v2/ko`
- API 키: 기본 공개 API 사용 시 필요하지 않습니다.
- 웹사이트: [tcgdex.net](https://www.tcgdex.net/) · [API 문서](https://tcgdex.dev/)
- TCGdex는 게임 카드 카탈로그이며 국내의 현재 판매 여부, 한국 소매 가격, 카드 시세를 보증하는 판매처가 아닙니다. `ko` 지역 데이터가 제공되지 않거나 API에서 오류가 나면 오류 상태를 표시합니다. 다른 지원 언어 카탈로그를 시험할 때는 `TCGDEX_API_BASE`를 예를 들어 `https://api.tcgdex.net/v2/en`으로 변경할 수 있지만, 해당 카드와 세트가 한국판이라는 의미는 아닙니다.
- 판매 가격과 발매 정보가 공식적으로 확인되지 않으면 판매 중·정가로 표시하지 않습니다. 최신 한국 판매 카드팩을 포괄하는 공식 API가 연결되지 않은 상태에서는 오래되었거나 근거가 불명확한 팩 이름을 fallback으로 만들지 않습니다. API 데이터 갱신 시각과 국내 판매 상태 미확인을 화면에서 구분합니다.

### 카드 시세 — 별도 공급자 연동 필요

한국판 카드에 대한 신뢰할 수 있고 공개된 무료 시세 API가 기본적으로 제공된다고 가정하지 않습니다. 실제 거래 데이터 공급자와 사용 권한을 확보한 뒤 `PRICE_API_URL`을 서버 환경 변수로 설정합니다. 공급자는 아래 bulk 응답 형식을 제공해야 합니다. 외부 공급자의 API 키가 필요하면 서버의 `PRICE_API_KEY` 환경 변수로 넣으세요. 키를 `script.js`나 HTML에 넣으면 안 됩니다.

요청: `GET {PRICE_API_URL}?ids={comma-separated-card-ids}`

```json
{
  "source": "가격 제공처 이름",
  "checkedAt": "2026-01-15T06:30:00.000Z",
  "prices": [
    {
      "cardId": "카탈로그 카드 ID",
      "price": 125.5,
      "currency": "USD",
      "changePercent": 4.2,
      "checkedAt": "2026-01-15T06:30:00.000Z",
      "source": "가격 제공처 이름",
      "sourceUrl": "https://example.com/listing/123"
    }
  ]
}
```

`currency`가 `KRW`이면 그대로 원화로 표시합니다. 다른 통화는 서버가 ExchangeRate-API 공개 환율 엔드포인트에서 해당 통화/KRW 환율을 가져와 환산을 시도합니다. 환율을 가져오지 못하면 검증되지 않은 원화 가격으로 바꾸지 않고 원래 통화로 표시합니다. 환산 가격은 카드판·언어별 가격 차이를 없애지 않으며, 미국판의 USD 가격을 한국판의 시세로 간주해서는 안 됩니다. 공급자가 `changePercent`, `checkedAt`, `sourceUrl`을 주지 않으면 해당 정보는 확인 불가 또는 미제공으로 표시합니다.

Pokemon TCG API(`https://pokemontcg.io/`) 및 TCGplayer/Cardmarket 데이터는 영어권 카드와 통화 중심입니다. API 키를 발급받을 수 있지만, 그 가격을 한국판 카드 가격처럼 보여주면 안 됩니다. 한국판 실제 시세를 표시하려면 한국판을 식별할 수 있고 라이선스/약관상 사용이 허용된 한국 거래 데이터 제공처가 필요합니다. 공급자 응답을 위 형식으로 변환하는 어댑터를 서버에 추가하고, `cardId`가 동일한 언어·판본의 카드와 매핑되는지 확인하세요.

## API / 백엔드 구조

- `server.js`: 정적 파일 서버 및 브라우저와 외부 API 사이의 서버 측 프록시. API 키가 브라우저에 노출되지 않습니다.
- `GET /api/health`: 카탈로그와 시세 공급자 연결 설정 상태.
- `GET /api/sets`: TCGdex 카드팩 목록.
- `GET /api/sets/{id}`: 카드팩과 카드 목록, 설정 시 bulk 가격 정보.
- `GET /api/cards/{id}`: 카드 상세 및 설정 시 가격.
- `GET /api/prices?ids=...`: 설정된 가격 공급자에서 가격을 확인.
- 서버 메모리 캐시: 카드팩/카드 기본 15분, 가격 5분, 환율 6시간. `CACHE_TTL_SECONDS`로 카탈로그 캐시를 조절합니다.

과거 가격 그래프와 사용자별 관심 카드까지 제공하려면 서버의 가격 응답을 PostgreSQL/Supabase 또는 Firebase에 시각·출처와 함께 저장하는 작업이 추가로 필요합니다. 현재 화면은 공급자가 응답하는 현재 가격과 변동률만 표시하며, 보유하지 않은 과거 데이터를 생성하지 않습니다.

## 배포

- **Vercel / Netlify**: 프런트엔드 정적 파일과 `server.js`는 별개로 배포합니다. Node 서버를 플랫폼의 서버리스 함수로 옮겨 API 경로를 연결하고, `PRICE_API_URL`/`PRICE_API_KEY`는 플랫폼 환경 변수에 등록해야 합니다.
- **GitHub Pages**: 정적 프런트엔드만 호스팅하므로 같은 출처의 `/api/*` Node 서버를 실행할 수 없습니다. 백엔드를 별도 서버/서버리스 플랫폼에 배포하고 `script.js`의 API 경로를 해당 백엔드 주소로 설정하는 구성이 필요합니다. 키를 정적 코드에 넣지 마세요.
- 운영 배포 전 API 제공자의 CORS/약관, 요청 제한, API 키 권한을 확인하세요. 서버리스 환경에서는 프로세스 메모리 캐시 대신 Redis나 플랫폼 캐시를 고려할 수 있습니다.

## 파일 구성

- `index.html`: 페이지 구조
- `style.css`: 반응형 UI와 다크 모드
- `script.js`: 화면 상태, 검색/필터/정렬, API 호출
- `server.js`: Node 백엔드 프록시 및 캐시
