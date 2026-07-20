const pagefindPromise = import(
  new URL('../pagefind/pagefind.js', import.meta.url).href
);

async function pagefind() {
  return pagefindPromise;
}

function allowsKnowledgeBase(sectionFilter) {
  if (sectionFilter === undefined) return true;
  if (typeof sectionFilter === 'string') return sectionFilter === 'kb';
  if (Array.isArray(sectionFilter)) return sectionFilter.includes('kb');
  return true;
}

function withKnowledgeBaseFilter(searchOptions = {}) {
  return {
    ...searchOptions,
    filters: {
      ...searchOptions.filters,
      section: 'kb',
    },
  };
}

function contextualBoost() {
  const search = document.querySelector(
    'site-search[data-knowledge-base-search]'
  );
  return Number(search?.dataset.contextualBoost ?? 1.5);
}

export async function search(term, searchOptions = {}) {
  const api = await pagefind();
  const results = await api.search(term, searchOptions);

  if (
    !results?.results?.length ||
    !allowsKnowledgeBase(searchOptions.filters?.section)
  ) {
    return results;
  }

  const knowledgeBaseResults = await api.search(
    term,
    withKnowledgeBaseFilter(searchOptions)
  );
  const knowledgeBaseIds = new Set(
    knowledgeBaseResults.results.map((result) => result.id)
  );
  const originalOrder = new Map(
    results.results.map((result, index) => [result.id, index])
  );
  const boost = contextualBoost();

  results.results.sort((left, right) => {
    const leftScore = left.score * (knowledgeBaseIds.has(left.id) ? boost : 1);
    const rightScore =
      right.score * (knowledgeBaseIds.has(right.id) ? boost : 1);

    return (
      rightScore - leftScore ||
      originalOrder.get(left.id) - originalOrder.get(right.id)
    );
  });

  return results;
}

export async function preload(term, searchOptions = {}) {
  const api = await pagefind();
  const requests = [api.preload(term, searchOptions)];

  if (allowsKnowledgeBase(searchOptions.filters?.section)) {
    requests.push(api.preload(term, withKnowledgeBaseFilter(searchOptions)));
  }

  await Promise.all(requests);
}

export async function options(...args) {
  return (await pagefind()).options(...args);
}

export async function init(...args) {
  return (await pagefind()).init(...args);
}

export async function filters(...args) {
  return (await pagefind()).filters(...args);
}

export async function mergeIndex(...args) {
  return (await pagefind()).mergeIndex(...args);
}

export async function debouncedSearch(...args) {
  return (await pagefind()).debouncedSearch(...args);
}

export async function destroy(...args) {
  return (await pagefind()).destroy(...args);
}
