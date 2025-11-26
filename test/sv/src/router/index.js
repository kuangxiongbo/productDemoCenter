import { createRouter, createWebHistory } from 'vue-router'
import Layout from '../components/Layout.vue'
import UserManagement from '../views/UserManagement.vue'
import SSLVpnAccessSettings from '../views/SSLVpnAccessSettings.vue'



// 动态获取基础路径（自动配置）
function getBasePath() {
  const currentPath = window.location.pathname;
  console.log('[getBasePath] currentPath:', currentPath); // 添加调试日志

  // 解码路径，确保中文路径正确处理
  const decodedPath = decodeURIComponent(currentPath);
  console.log('[getBasePath] decodedPath:', decodedPath); // 添加调试日志

  // 优先检查是否以 /dist/index.html 结尾
  if (decodedPath.endsWith('/dist/index.html')) {
    const basePath = decodedPath.substring(0, decodedPath.length - 10); // /project-name/dist/
    console.log('[getBasePath] Case 1 (/dist/index.html):', basePath);
    return basePath;
  }

  // 如果路径包含 /dist/，提取到 /dist/ 为止
  if (decodedPath.includes('/dist/')) {
    const distIndex = decodedPath.indexOf('/dist/');
    const basePath = decodedPath.substring(0, distIndex + 5); // 包含 /dist/
    console.log('[getBasePath] Case 2 (includes /dist/):', basePath);
    return basePath;
  }

  // 如果路径以 /dist 结尾（没有斜杠）
  if (decodedPath.endsWith('/dist')) {
    const basePath = decodedPath + '/'; // 添加末尾斜杠
    console.log('[getBasePath] Case 3 (ends with /dist):', basePath);
    return basePath;
  }

  // 如果访问的是项目根目录（如 /project-name/ 或 /父目录/子目录/project-name/），basename 应该是完整路径
  // 匹配：/路径/ 或 /路径/xxx
  // 支持嵌套路径，如 /基础设施业务线/sv/ 或 /中文/sv/
  const projectMatch = decodedPath.match(/^\/(.+?)(?:\/dist\/|\/dist$|\/dist\/index\.html$|$)/);
  if (projectMatch) {
    const fullPathSegment = projectMatch[1]; // 完整路径，如 "基础设施业务线/sv"
    const basePath = '/' + fullPathSegment + '/';
    console.log('[getBasePath] Case 4 (project root):', basePath);
    return basePath;
  }

  // 默认返回空字符串（根路径）
  console.log('[getBasePath] Case 5 (default):', '');
  return '';
}
const routes = [
  {
    path: '/',
    component: Layout,
    redirect: '/user-management',
    children: [
      {
        path: '/user-management',
        name: 'UserManagement',
        component: UserManagement
      },
      {
        path: '/ssl-vpn/access-settings',
        name: 'SSLVpnAccessSettings',
        component: SSLVpnAccessSettings
      }
    ]
  }
]

const router = createRouter({
  history: createWebHistory((typeof window !== 'undefined' && window.getBasePath && typeof window.getBasePath === 'function') ? window.getBasePath() : (typeof getBasePath === 'function' ? getBasePath() : '')),
  routes
})

export default router

