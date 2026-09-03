/*
Copyright 2019-2024 The Tekton Authors
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at
    http://www.apache.org/licenses/LICENSE-2.0
Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { fireEvent, waitFor } from '@testing-library/react';

import LabelFilter from './LabelFilter';
import { render } from '../../utils/test';

it('LabelFilter renders', () => {
  const filter = 'tekton.dev/pipeline=demo-pipeline';
  const { queryByText } = render(<LabelFilter filters={[filter]} />);
  expect(queryByText(/Search by name/i)).not.toBeNull();
  expect(queryByText(filter.replace('=', ':'))).not.toBeNull();
});

it('LabelFilter treats free text as a search query rather than a label', () => {
  const handleAddFilter = vi.fn();
  const { getByPlaceholderText, getByText, queryByText } = render(
    <LabelFilter handleAddFilter={handleAddFilter} />
  );
  fireEvent.change(getByPlaceholderText(/search by name/i), {
    target: { value: 'my-pipeline' }
  });
  fireEvent.submit(getByText(/Search by name/i));
  expect(handleAddFilter).not.toHaveBeenCalled();
  expect(queryByText('my-pipeline')).not.toBeNull();
});

it('LabelFilter broadcasts free text as a search query while typing', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const onSearch = vi.fn(event => event.detail.q);
  window.addEventListener('tkn:textSearch', onSearch);
  try {
    const { getByPlaceholderText } = render(<LabelFilter />);
    fireEvent.change(getByPlaceholderText(/search by name/i), {
      target: { value: 'my-pipeline' }
    });
    // debounced, so nothing broadcast yet
    expect(onSearch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onSearch.mock.results[0].value).toEqual('my-pipeline');

    // clearing the input clears the search
    fireEvent.change(getByPlaceholderText(/search by name/i), {
      target: { value: '' }
    });
    expect(onSearch).toHaveBeenCalledTimes(2);
    expect(onSearch.mock.results[1].value).toEqual('');
  } finally {
    window.removeEventListener('tkn:textSearch', onSearch);
    vi.useRealTimers();
  }
});

it('LabelFilter does not search text that was deleted before the debounce fired', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const onSearch = vi.fn(event => event.detail.q);
  window.addEventListener('tkn:textSearch', onSearch);
  try {
    const { getByPlaceholderText, queryByText } = render(<LabelFilter />);
    const input = getByPlaceholderText(/search by name/i);

    // 타이핑 후 디바운스가 끝나기 전에 한 글자씩 지운다
    for (const value of ['abc', 'ab', 'a', '']) {
      fireEvent.change(input, { target: { value } });
    }
    await vi.advanceTimersByTimeAsync(1000);

    // 남아 있던 타이머가 뒤늦게 'a'를 검색어로 걸면 안 된다
    expect(onSearch.mock.results.map(r => r.value)).not.toContain('a');
    expect(queryByText('a')).toBeNull();
  } finally {
    window.removeEventListener('tkn:textSearch', onSearch);
    vi.useRealTimers();
  }
});

it('LabelFilter cancels a pending search when the query tag is dismissed', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const onSearch = vi.fn(event => event.detail.q);
  window.addEventListener('tkn:textSearch', onSearch);
  try {
    const { getByPlaceholderText, getByText, queryByText } = render(
      <LabelFilter />
    );
    const input = getByPlaceholderText(/search by name/i);

    fireEvent.change(input, { target: { value: 'abc' } });
    await vi.advanceTimersByTimeAsync(500);
    expect(queryByText('abc')).not.toBeNull();

    // 검색어를 다시 바꾼 뒤 디바운스 전에 태그를 닫는다
    fireEvent.change(input, { target: { value: 'abcd' } });
    fireEvent.click(getByText('abc'));
    await vi.advanceTimersByTimeAsync(1000);

    expect(onSearch.mock.results.at(-1).value).toEqual('');
    expect(queryByText('abcd')).toBeNull();
  } finally {
    window.removeEventListener('tkn:textSearch', onSearch);
    vi.useRealTimers();
  }
});

it('LabelFilter handles adding a filter', () => {
  const filter = 'app:test';
  const handleAddFilter = vi.fn();
  const { getByPlaceholderText, getByText } = render(
    <LabelFilter handleAddFilter={handleAddFilter} />
  );
  fireEvent.change(getByPlaceholderText(/search by name/i), {
    target: { value: filter }
  });
  fireEvent.submit(getByText(/Search by name/i));
  expect(handleAddFilter).toHaveBeenCalledWith([filter.replace(':', '=')]);
});

it('LabelFilter displays notification if character length is over 63 characters for labelValue', async () => {
  const filter =
    'app:1234567890123456789012345678901234567890123456789012345678901234';
  const handleAddFilter = vi.fn();
  const { getByPlaceholderText, getByText, getByTitle, queryByText } = render(
    <LabelFilter handleAddFilter={handleAddFilter} />
  );
  fireEvent.change(getByPlaceholderText(/search by name/i), {
    target: { value: filter }
  });
  fireEvent.submit(getByText(/Search by name/i));
  expect(handleAddFilter).not.toHaveBeenCalled();
  await waitFor(() =>
    getByText(
      /Filters must be of the format labelKey:labelValue and contain less than 64 characters/i
    )
  );
  fireEvent.click(getByTitle(/close notification/i));
  expect(
    queryByText(
      /Filters must be of the format labelKey:labelValue and contain less than 64 characters/i
    )
  ).toBeNull();
});

it('LabelFilter handles adding a duplicate filter', async () => {
  const filter = 'app=test';
  const filterDisplayValue = 'app:test';
  const handleAddFilter = vi.fn();
  const { getByPlaceholderText, getByText, getByTitle, queryByText } = render(
    <LabelFilter filters={[filter]} handleAddFilter={handleAddFilter} />
  );
  fireEvent.change(getByPlaceholderText(/search by name/i), {
    target: { value: filterDisplayValue }
  });
  fireEvent.submit(getByText(/Search by name/i));
  expect(handleAddFilter).not.toHaveBeenCalled();
  await waitFor(() => getByText(/no duplicate filters allowed/i));
  fireEvent.click(getByTitle(/close notification/i));
  expect(queryByText(/no duplicate filters allowed/i)).toBeNull();
});

it('LabelFilter handles deleting a filter', () => {
  const filter = 'tekton.dev/pipeline=demo-pipeline';
  const handleDeleteFilter = vi.fn();
  const { getByText } = render(
    <LabelFilter filters={[filter]} handleDeleteFilter={handleDeleteFilter} />
  );
  fireEvent.click(getByText(filter.replace('=', ':')));
  expect(handleDeleteFilter).toHaveBeenCalledWith(filter);
});

it('LabelFilter handles clearing all filters', () => {
  const filter = 'tekton.dev/pipeline=demo-pipeline';
  const handleClearFilters = vi.fn();
  const { getByText } = render(
    <LabelFilter filters={[filter]} handleClearFilters={handleClearFilters} />
  );
  fireEvent.click(getByText(/clear all/i));
  expect(handleClearFilters).toHaveBeenCalled();
});
