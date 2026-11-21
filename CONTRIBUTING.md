# Contributing

이 저장소는 설치 목록입니다. `claude plugin marketplace add airmang/hwpx-plugins`와
`codex plugin marketplace add airmang/hwpx-plugins`가 읽는 두 파일(`.claude-plugin/marketplace.json`,
`.agents/plugins/marketplace.json`)과 `packaging/product-identity.json`만 관리합니다.

플러그인 소스(스킬, 참고 문서, 호스트 번들 빌드, 시험)는
[python-hwpx-automation](https://github.com/airmang/python-hwpx-automation)의 `plugins-src/`에 있습니다.
고칠 것은 그 저장소에 PR로 보내 주세요. 호스트 번들은 그 저장소의 `plugins-dist` 가지로 내보내고,
이 저장소의 설치 목록이 그 가지를 가리킵니다.

버그와 제안은 이 저장소의 이슈로 보내셔도 됩니다.
