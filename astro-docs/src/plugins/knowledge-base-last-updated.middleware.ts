import { defineRouteMiddleware } from '@astrojs/starlight/route-data';
import {
  getKnowledgeBaseLastModifiedDates,
  kbTopics,
} from '../utils/knowledge-base';

const lastModifiedDates = getKnowledgeBaseLastModifiedDates();
const topicIds = new Set(kbTopics.map((topic) => topic.id));

export const onRequest = defineRouteMiddleware((context) => {
  const routeId = context.locals.starlightRoute.id;
  if (!routeId.startsWith('kb/')) return;

  const slug = routeId.slice('kb/'.length);
  if (topicIds.has(slug)) return;

  const lastModified = lastModifiedDates.get(slug);
  if (lastModified) {
    context.locals.starlightRoute.lastUpdated = lastModified;
  }
});
