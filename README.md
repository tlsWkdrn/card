# Cardlog — Pokémon TCG Explorer

TCGdex의 카드팩·카드 카탈로그를 불러오는 반응형 웹 앱입니다. 카드 정보와 가격 정보의 출처를 분리해 표시하고, 가격 공급자가 연결되지 않으면 가격을 임의로 만들지 않고 `가격 정보 없음`으로 표시합니다.

## 실행

필수 조건은 Node.js 18 이상입니다. 의존성 설치 없이 실행할 수 있습니다.

```bash
npm start
```

브라우저에서 `http://localhost:3000`을 엽니다. `.env.example`의 설정은 기본값과 같으므로 별도 설정 없이 시작할 수 있습니다. API 프록시가 403/404로 응답하는 정적 호스팅 환경에서도 브라우저가 공개 TCGdex API로 재시도하도록 fallback을 추가했습니다. 환경 변수를 바꾸는 경우 현재 터미널 세션에 설정한 뒤 `npm start`를 실행하거나, 배포 플랫폼의 환경 변수 설정을 이용하세요.

예: PowerShell

```powershell
$env:PRICE_API_URL = 'https://your-price-service.example/api/prices'
$env:PRICE_API_KEY = 'your-secret-key'
npm start
```

## 데이터 출처와 한계

### 카드팩과 카드 정보 — TCGdex

- API: `https://api.tcgdex.net/v2/ko/sets`, `/sets/{id}`, `/cards/{id}`
- 이 프로젝트의 기본 API base: 한국어 `https://api.tcgdex.net/v2/ko`, 국제 카드 검색용 영어 `https://api.tcgdex.net/v2/en`
- API 키: 기본 공개 API 사용 시 필요하지 않습니다.
- 웹사이트: [tcgdex.net](https://www.tcgdex.net/) · [API 문서](https://tcgdex.dev/)
- TCGdex는 게임 카드 카탈로그이며 국내의 현재 판매 여부, 한국 소매 가격, 카드 시세를 보증하는 판매처가 아닙니다. `ko` 지역 데이터가 제공되지 않거나 API에서 오류가 나면 오류 상태를 표시합니다. 다른 지원 언어 카탈로그를 시험할 때는 `TCGDEX_API_BASE`를 예를 들어 `https://api.tcgdex.net/v2/en`으로 변경할 수 있지만, 해당 카드와 세트가 한국판이라는 의미는 아닙니다.
- 한국어 카드 카탈로그에는 일부 카드만 존재할 수 있어 통합 검색은 TCGdex 영어 카드 목록도 함께 검색합니다. PokeAPI Pokédex의 한국어/영어 포켓몬 이름 매핑을 이용해 `가디안`과 같은 한국 이름으로 국제판 카드명을 찾아 보여주며, 해당 카드는 국제판 데이터로 표시합니다. 같은 이름의 한국판 시세로 해석하지 않습니다.
- 검색 결과는 레어도 묶음으로 필터링할 수 있습니다. AR은 Art/Illustration Rare, SR은 Ultra/Super Rare, RR은 Double/Triple Rare, UR은 Hyper/Secret Rare를 묶어 보여주며 SAR, 일반, 기타도 별도로 고를 수 있습니다. TCGdex의 원본 레어도 문자열은 카드마다 함께 표시합니다.
- 판매 가격과 발매 정보가 공식적으로 확인되지 않으면 판매 중·정가로 표시하지 않습니다. 최신 한국 판매 카드팩을 포괄하는 공식 API가 연결되지 않은 상태에서는 오래되었거나 근거가 불명확한 팩 이름을 fallback으로 만들지 않습니다. API 데이터 갱신 시각과 국내 판매 상태 미확인을 화면에서 구분합니다.

### 카드 시세 — 해외 참고 시세 및 별도 한국 공급자

TCGdex 카드 정보에 TCGplayer(USD) 또는 Cardmarket(EUR) 가격이 포함된 경우, 앱은 실제 제공된 가격과 갱신일을 사용하고 공개 환율로 KRW 참고 환산값을 함께 표시합니다. 이는 해외 시장 가격이며 한국판·국내 거래 가격이 아닙니다. 한국 시세로 오인되지 않도록 시장 지역과 원래 통화, 출처를 함께 표시합니다. 한국판 카드에 대한 신뢰할 수 있고 공개된 무료 시세 API가 기본적으로 제공된다고 가정하지 않습니다. 한국 시장 가격이 필요하면 실제 거래 데이터 공급자와 사용 권한을 확보한 뒤 `PRICE_API_URL`을 서버 환경 변수로 설정하세요.

가격 공급자는 아래 bulk 응답 형식을 제공해야 합니다. 외부 공급자의 API 키가 필요하면 서버의 `PRICE_API_KEY` 환경 변수로 넣으세요. 키를 `script.js`나 HTML에 넣으면 안 됩니다. 설정한 공급자의 카드별 가격이 누락된 경우 TCGdex 국제 가격이 있으면 참고 가격으로 fallback됩니다.

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
- `GET /api/search?q={이름}`: 한국어·영어 카드 카탈로그와 카드팩을 통합 검색하고 가능한 경우 TCGplayer/Cardmarket 시장가격을 환산해 함께 반환합니다. 카드 결과가 많으면 `offset`으로 다음 결과를 가져옵니다.
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
