fetch("https://amp-account.apps.apple.com/account/v1/compliance/terms/updateConsent?termsType=iCloud&cc=NGA&context=changeCountry", {
    "headers": {
      "accept": "*/*",
      "accept-language": "zh-cn",
      "content-type": "application/json",
      "priority": "u=1, i",
      "sec-ch-ua": "\"Chromium\";v=\"146\", \"Not-A.Brand\";v=\"24\", \"Google Chrome\";v=\"146\"",
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": "\"macOS\"",
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-site",
      "x-apple-store-front": "143465-19,8",
      "cookie": "geo=CN; dslang=CN-ZH; site=CHN; acn01=/pL75ZKFtZr66XXI2KiKbJjSIMwu7KCl8z2CmenrtwARgJxn+R/j; myacinfo=DAWTKNV323952cf8084a204fb20ab2508441a07d02d3e65a61b439e166c4980afbb684f1d4a1cc3b79b073c6720ce7c18fd9990c0f180c129f852a6f16c0249142bffd12525493f35ea69f206cd5975551d673f57201c93779ee3998e14c26c110cd047edd36fc1defd8ead2360e5e8c5885a9f478de0f6255b449329ca782510cba7dda791f82e20775df70b5dcba19c46010e9fc3d44e2ea378e2ed8e4d818a763be9848a1474f665adc43fb935a24bdada0578e574d63be369bdf34d0f56e0ddcf4ed0210b6099e01297854413fced1bb345454502e811d124f613e907e394263937f464f0287dc6819f76c0bb115e0cfc9e07c9529f5b3cf7f3eb39d046ca64f3cc8432988c09644b2b217d0ec9491efee92798dc86253c0b04c62dc3d9fb6159cfe50d0aa19c5f7f4cca97acfdc6eb45497820d15791588aae05624d0334a09d614d60a2f28869927414c83b80ef32c4c58371e2e3e280b0609ba319f5380fb142beab8d3d131ec933a8f38f4d37dd3bed0c3f060c0ca85a4958af546a551cb1ae379c5744280f5744cc1956252148692fff12893e5ba362fb6d4459f0ab9d1df6563a5ffc08b5c61724b4d330539d5291972bf179d097cbae58d7002fd0d81966ac9cd50c62767b3277f69619af9a0227e9ff0fedc76789b42a306cb5318bde42b0346df7a8dc150be128c6dd87a4249f3d380771abc119d578c13d34e0946cf549299aa183a903b0f69b9a7cdc690d22ed5c111f388f6ec9b6d8bfbe7597d080682c6911887a78893d5ff7b9cbad2082943bfa962e1f38738f902a77195d744f62acab436442fa9e42b756a2150edb1e7ff434bdd03e7ffe198e684a3310f7d93c1c3cd764da0f81aa3344f46f5bbcd2c169fd0e885cc0fe8699bf123b412cb1cbc72585a47V3; itspod=44; pldfltcid=f02a123d93834dd596319cec105535f4044; pltvcid=undefined; commerce-authorization-token=AAAAAAAAAAL898LL6hEDnlaqBwaHLfMfHdhfi/m0rgjug1fLa6UhLtDt7hJV8L1S1ZV0dosgFtVSymhXA31BHEoz9ioxs8GZ2Ro1irWKCRmA+MKMiJLlDYBY9bVk0xSUWuZKDdTM3d+WtFhZQFiyEWdva75CR6PREHYitD7Gist+4tCIQf2wKdMDYZgiB/i2mRNSLisb1rQTtQGcUxYoyvEwbzR0E48RlL8FJJZPqDe1Q9SgbbEQ+w==; caw=MDAxNTk2LTA4LWE1M2YyNGRjLTllNjAtNDIxNS1hNjQ0LWRjN2I4MWIwNzNjNDpXU1RLTmM2ODJjOTM0LWJjNjAtNGU0OS1iNDk5LTdiNGU0MGYwN2Q4NldGbGFNYjRiaHpaVXptQ2F3WjJaNHc5bEJFUFdQem1NMFVlY3FZSUpRcUVWWlUrOCsvaDg1Mll0SlZMaDNrK3dTdWtwSFRKUTlEM3dVM2xZUmdaY1pRTDRWTC9HVm5BcFFXRi9uOUxlbml0UWJjQTB2dEY4U0ZQQXFlekFSZjRtbm9qVTBheHhNZHZpWW4zOWxMQ2xjT05UWE9ib0FyZVdkWWZhcnRKREo5QTBEekl4d3hCa0daeG9raGdocTArYVpZLzhjYUlTT2hxakJWSzhlb29HbDkxdlNxSm9pUnhQcGw4SnFxclNwVEE1YU5jWkZjUHJsUFc2ZFZpWGkzbjNna2w2NFdPMFl0SjhEdHlqNkE5dlpSQnRiMmM9MHZpTnlzeVg3YjFmM2M5Zi01MTJlLTQxYTYtYTYxYi1mYTNlOTM0OGQ2YjU1ODU5NWEzMjdlNzY2YmQ5Njc5ZGZjMjQxODE2ZTBiOTgyNDQ4YTY5ZmVlM2ZkYWVmZGFmMTRiMjE2MmYyNWUxMDlkZTFiZjY4ZjdjNDkxZGRkMzUwZWVlOTg0M2VkOGViZGRhNzgxMmI1Mjk1YTM2MTdlYzhiMmQ1YmE0MTM5NjMyMDA2ZmQwOWJmYWEzMWE5ZWM5NGQ2YjA0YTFiMDhhOGNHbUFJbm52Mg==; caw-at=eyJraWQiOiIxIiwiYWxnIjoiRVMyNTYifQ.eyJzdWIiOiIwMDE1OTYtMDgtYTUzZjI0ZGMtOWU2MC00MjE1LWE2NDQtZGM3YjgxYjA3M2M0IiwiaXNzIjoiY29tLmFwcGxlLmlkbXMuY2xpZW50IiwiZXhwIjoxNzc1ODE0NTEzLCJpYXQiOjE3NzU4MTM2MTN9.ZbW4FMombgn-0b1tHupxAzLuz8MoFco8vPNs97J8xbraP79WnVDHRn9WRKhA1JuUXKXBYfOD8O3a7GF1vRz5yg",
      "Referer": "https://apps.apple.com/"
    },
    "body": "{\"hasConsented\":true,\"versionId\":628501}",
    "method": "POST"
  }).then(res => res.json()).then(data => {
    console.log(data);
  }).catch(err => {
    console.error(err);
  });