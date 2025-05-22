// crawler.js
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs').promises;
const path = require('path');

class FSSCrawler {
  constructor() {
    this.baseUrl = 'https://www.fss.or.kr/fss/bbs/B0000188/list.do';
    this.dataDir = 'data';
    this.postsFile = path.join(this.dataDir, 'posts.json');
    this.filesFile = path.join(this.dataDir, 'files.json');

    // Axios 인스턴스 설정
    this.client = axios.create({
      timeout: 30000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        Connection: 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
      },
    });
  }

  async init() {
    try {
      await fs.mkdir(this.dataDir, { recursive: true });
    } catch (error) {
      // 디렉토리가 이미 존재하는 경우 무시
    }
  }

  async loadExistingData() {
    try {
      const [postsData, filesData] = await Promise.all([
        fs.readFile(this.postsFile, 'utf8').catch(() => '[]'),
        fs.readFile(this.filesFile, 'utf8').catch(() => '[]'),
      ]);

      return {
        posts: JSON.parse(postsData),
        files: JSON.parse(filesData),
      };
    } catch (error) {
      console.log('기존 데이터 로드 실패, 새로 시작합니다:', error.message);
      return { posts: [], files: [] };
    }
  }

  async saveData(posts, files) {
    try {
      await Promise.all([
        fs.writeFile(this.postsFile, JSON.stringify(posts, null, 2), 'utf8'),
        fs.writeFile(this.filesFile, JSON.stringify(files, null, 2), 'utf8'),
      ]);
      console.log('✅ 데이터 저장 완료');
    } catch (error) {
      console.error('❌ 데이터 저장 실패:', error);
    }
  }

  async crawlPage(page = 1) {
    let posts = [];

    try {
      // URL 파라미터 구성
      const params = {
        menuNo: '200218',
        bbsId: '',
        cl1Cd: '',
        pageIndex: page.toString(),
        sdate: '',
        edate: '',
        searchCnd: '1',
        searchWrd: '회계',
      };

      console.log(`📄 페이지 ${page} 크롤링 중...`);

      const response = await this.client.get(this.baseUrl, { params });
      const $ = cheerio.load(response.data);

      // 여러 가능한 테이블 구조 시도
      const possibleSelectors = [
        'table.board_list tbody tr',
        'table tbody tr',
        '.list_table tbody tr',
        '.board tbody tr',
        'table tr',
        'tbody tr',
      ];

      let rows = $();
      for (const selector of possibleSelectors) {
        rows = $(selector);
        if (rows.length > 1) {
          // 헤더 제외하고 데이터가 있으면
          break;
        }
      }

      console.log(`   - 발견된 행: ${rows.length}개`);

      rows.each((index, element) => {
        try {
          const cells = $(element).find('td');

          if (cells.length >= 3) {
            // 최소 3개 컬럼 필요
            // 첫 번째 셀이 번호인지 확인
            const firstCellText = $(cells[0]).text().trim();

            // 번호가 아닌 경우 (헤더, 공지사항 등) 스킵
            if (
              !firstCellText ||
              firstCellText === '번호' ||
              firstCellText === 'No.' ||
              firstCellText.includes('공지') ||
              !/^\d+$/.test(firstCellText)
            ) {
              return;
            }

            const postId = firstCellText;

            // 제목 추출 (보통 두 번째 컬럼)
            const titleCell = $(cells[1]);
            const title = titleCell.text().trim();

            if (!title || title.length < 2) {
              return; // 제목이 너무 짧으면 스킵
            }

            // 링크 추출
            let postUrl = '';
            const linkElement = titleCell.find('a');
            if (linkElement.length > 0) {
              const href = linkElement.attr('href');
              const onclick = linkElement.attr('onclick');

              if (href && !href.startsWith('javascript:')) {
                postUrl = href.startsWith('http')
                  ? href
                  : `https://www.fss.or.kr${href}`;
              } else if (onclick) {
                // JavaScript 함수에서 게시글 ID 추출
                const match = onclick.match(
                  /(?:fn_egov_inqire_notice|goView)\s*\(\s*['"]?(\d+)['"]?/
                );
                if (match) {
                  postUrl = `https://www.fss.or.kr/fss/bbs/B0000188/view.do?menuNo=200218&nttId=${match[1]}`;
                }
              }
            }

            // 나머지 컬럼들 추출
            const author = cells.length > 2 ? $(cells[2]).text().trim() : '';
            const datePosted =
              cells.length > 3 ? $(cells[3]).text().trim() : '';
            const views = cells.length > 4 ? $(cells[4]).text().trim() : '0';

            const post = {
              id: postId,
              title: title,
              author: author,
              date_posted: datePosted,
              views: views,
              url: postUrl,
              crawled_at: new Date().toISOString(),
            };

            console.log(
              `   ✓ ${title.substring(0, 50)}${title.length > 50 ? '...' : ''}`
            );
            posts.push(post);
          }
        } catch (error) {
          console.warn(`   ⚠️  행 파싱 오류: ${error.message}`);
        }
      });
    } catch (error) {
      console.error(`❌ 페이지 ${page} 크롤링 오류:`, error.message);

      if (error.response) {
        console.error(`   HTTP 상태: ${error.response.status}`);
        console.error(
          `   응답 길이: ${error.response.data?.length || 0} chars`
        );
      }
    }

    return posts;
  }

  async crawlPostDetail(post) {
    if (!post.url) {
      return [];
    }

    let files = [];

    try {
      console.log(`   📎 첨부파일 확인: ${post.title.substring(0, 30)}...`);

      const response = await this.client.get(post.url);
      const $ = cheerio.load(response.data);

      // 첨부파일 링크 찾기 - 여러 패턴 시도
      const fileSelectors = [
        'a[href*="attach"]',
        'a[href*="file"]',
        'a[href*="down"]',
        'a[href*="upload"]',
        '.attach a',
        '.file a',
        '.download a',
      ];

      const foundLinks = new Set(); // 중복 방지

      for (const selector of fileSelectors) {
        $(selector).each((index, element) => {
          const fileName = $(element).text().trim();
          let fileUrl = $(element).attr('href');

          if (fileUrl && fileName && fileName.length > 0) {
            // 상대 경로를 절대 경로로 변환
            if (fileUrl.startsWith('/')) {
              fileUrl = `https://www.fss.or.kr${fileUrl}`;
            }

            // 파일 확장자 확인 또는 의미있는 파일명
            const isFile =
              fileName.match(
                /\.(pdf|hwp|doc|docx|xls|xlsx|ppt|pptx|zip|rar|txt)$/i
              ) ||
              fileName.includes('첨부') ||
              fileName.includes('파일');

            if (isFile && !foundLinks.has(fileUrl)) {
              foundLinks.add(fileUrl);

              files.push({
                post_id: post.id,
                post_title: post.title,
                file_name: fileName,
                file_url: fileUrl,
                found_at: new Date().toISOString(),
              });

              console.log(`     📄 ${fileName}`);
            }
          }
        });
      }
    } catch (error) {
      console.warn(`   ⚠️  상세 페이지 오류 (${post.url}): ${error.message}`);
    }

    return files;
  }

  async delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async run() {
    console.log('🚀 FSS 게시판 크롤링 시작 (Axios 버전)');

    await this.init();

    // 기존 데이터 로드
    const { posts: existingPosts, files: existingFiles } =
      await this.loadExistingData();

    const existingPostIds = new Set(existingPosts.map((post) => post.id));
    const allPosts = [...existingPosts];
    const allFiles = [...existingFiles];
    const newPosts = [];

    try {
      // 처음 3페이지 크롤링
      for (let page = 1; page <= 3; page++) {
        const posts = await this.crawlPage(page);

        let newInPage = 0;
        for (const post of posts) {
          if (!existingPostIds.has(post.id)) {
            newPosts.push(post);
            allPosts.push(post);
            existingPostIds.add(post.id);
            newInPage++;
          }
        }

        console.log(
          `   📊 페이지 ${page}: 전체 ${posts.length}개, 신규 ${newInPage}개`
        );

        // 요청 간격 조절 (서버 부하 방지)
        if (page < 3) {
          await this.delay(1500);
        }
      }

      console.log(`\n📝 새 게시글 ${newPosts.length}개 발견`);

      // 새 게시글의 첨부파일 크롤링
      for (let i = 0; i < newPosts.length; i++) {
        const post = newPosts[i];
        console.log(`📎 [${i + 1}/${newPosts.length}] 첨부파일 확인 중...`);

        const files = await this.crawlPostDetail(post);
        allFiles.push(...files);

        // 요청 간격 조절
        if (i < newPosts.length - 1) {
          await this.delay(1000);
        }
      }

      // 데이터 정렬 (최신순) - 게시글 ID 기준 (숫자가 클수록 최신)
      allPosts.sort((a, b) => {
        const idA = parseInt(a.id) || 0;
        const idB = parseInt(b.id) || 0;
        return idB - idA; // 내림차순 (큰 ID가 먼저)
      });

      allFiles.sort((a, b) => new Date(b.found_at) - new Date(a.found_at));

      // 데이터 저장
      await this.saveData(allPosts, allFiles);

      console.log(`\n✨ 크롤링 완료!`);
      console.log(`   📄 전체 게시글: ${allPosts.length}개`);
      console.log(`   🆕 새 게시글: ${newPosts.length}개`);
      console.log(`   📎 총 첨부파일: ${allFiles.length}개`);
    } catch (error) {
      console.error('💥 크롤링 실패:', error);
      process.exit(1);
    }
  }
}

// 실행
if (require.main === module) {
  const crawler = new FSSCrawler();
  crawler.run().catch(console.error);
}

module.exports = FSSCrawler;
