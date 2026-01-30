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

import { Component } from 'react';
import { injectIntl } from 'react-intl';
import { Button, Form, Link, Search, Tag } from '@carbon/react';
import { ActionableNotification } from '..';

function arrayUnique(arr) {
  return arr.filter((item, index) => arr.indexOf(item) >= index);
}

// 라벨 패턴: labelKey:labelValue[,labelKey:labelValue...]
const LABEL_REGEX = /^(?:[a-z0-9A-Z-_./]+:[a-z0-9A-Z-_.]+,?)+$/;

// filters 배열(= ["k=v","a=b"]) -> labelSelector 문자열
function buildLabelSelectorFromFilters(filters = []) {
  return (filters || []).join(',');
}

/* ▼ 추가: 전역 이벤트 & URL 쿼리 유틸 (window 안전하게) */
function broadcastTextQuery(q) {
  try {
    if (typeof window !== 'undefined' && window.dispatchEvent) {
      window.dispatchEvent(new CustomEvent('tkn:textSearch', { detail: { q } }));
    }
  } catch {}
}
/* ▲ 추가 끝 */

class LabelFilter extends Component {
  state = {
    currentFilterValue: '',
    isValid: true,
    filterMessage: null,
    url: '',
    urlMessage: '',
    textQuery: ''
  };

  debounceTimer = null;

  componentDidMount() {
    this.emitSelectorIfNeeded(this.props.filters);
  }

  componentDidUpdate(prevProps, prevState) {
    if (prevProps.filters !== this.props.filters) {
      this.emitSelectorIfNeeded(this.props.filters);
    }
    if (
      prevState.currentFilterValue !== this.state.currentFilterValue &&
      this.state.currentFilterValue.trim() === '' &&
      this.state.textQuery !== ''
    ) {
      this.clearTextSearch();
    }
  }

  componentWillUnmount() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
  }

  emitSelectorIfNeeded = (filters) => {
    const selector = buildLabelSelectorFromFilters(filters);
    this.props.onBuildSelector?.(selector);
  };

  // 일반 텍스트 검색 적용/해제
  applyTextSearch = (query) => {
    const trimmed = (query || '').trim();
    if (this.state.textQuery === trimmed) return;
    this.setState({ textQuery: trimmed });
    this.props.onTextSearch?.(trimmed);
    broadcastTextQuery(trimmed);
  };

  clearTextSearch = () => {
    this.setState({ textQuery: '' });
    this.props.onTextSearch?.('');
    broadcastTextQuery('');
  };

  handleAddFilter = (event) => {
    event.preventDefault();

    const { intl } = this.props;
    const { currentFilterValue } = this.state;

    const rawInput = currentFilterValue || '';
    const trimmedInput = rawInput.trim();

    if (!trimmedInput) {
      if (this.state.textQuery) this.clearTextSearch();
      return;
    }

    const compact = trimmedInput.replace(/\s/g, '');
    if (LABEL_REGEX.test(compact)) {
      const colonToEquals = compact.replace(/:/g, '=');
      let currentFiltersArray = arrayUnique(colonToEquals.split(','));

      const tooLong = currentFiltersArray.some(f => {
        const [, value] = f.split('=');
        return value && value.length > 63;
      });
      if (tooLong) {
        this.setState({
          isValid: false,
          filterMessage: intl.formatMessage({
            id: 'dashboard.labelFilter.invalidLength',
            defaultMessage:
              'Filters must be of the format labelKey:labelValue and contain less than 64 characters'
          }),
          url: '',
          urlMessage: ''
        });
        return;
      }

      const hasDup = currentFiltersArray.some(f => this.props.filters.includes(f));
      if (hasDup) {
        this.setState({
          isValid: false,
          filterMessage: intl.formatMessage({
            id: 'dashboard.labelFilter.duplicate',
            defaultMessage: 'No duplicate filters allowed'
          }),
          url: '',
          urlMessage: ''
        });
        return;
      }

      this.props.handleAddFilter(
        arrayUnique(this.props.filters.concat(currentFiltersArray))
      );
      this.resetCurrentFilterValue();
      return;
    }

    // 일반 텍스트 검색
    this.setState({ isValid: true, filterMessage: null, url: '', urlMessage: '' });
    this.applyTextSearch(trimmedInput);
    this.resetCurrentFilterValue();
  };

  handleChange = (event) => {
    const inputValue = event.target.value;
    this.setState({ currentFilterValue: inputValue });

    const val = (inputValue || '').trim();
    if (val === '') { this.clearTextSearch(); return; }
    const compact = val.replace(/\s/g, '');
    if (!LABEL_REGEX.test(compact)) {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        if (val !== '') this.applyTextSearch(val);   // ▼ this.state 대신 캡처값 사용
      }, 400);
    } else if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
  };

  handleCloseFilterError = () => {
    this.setState({
      isValid: true,
      filterMessage: null,
      url: '',
      urlMessage: ''
    });
  };

  resetCurrentFilterValue() {
    this.setState({
      isValid: true,
      filterMessage: null,
      url: '',
      urlMessage: '',
      currentFilterValue: ''
    });
  }

  render() {
    const { filters, intl } = this.props;
    const {
      currentFilterValue,
      filterMessage,
      isValid,
      url,
      urlMessage,
      textQuery
    } = this.state;

    const searchDescription = intl.formatMessage({
      id: 'dashboard.labelFilter.searchPlaceholder',
      defaultMessage: 'Search by label (labelKey:labelValue) or free text'
    });

    return (
      <div className="tkn--label-filter">
        {!isValid && (
          <ActionableNotification
            inline
            kind="error"
            lowContrast
            title={filterMessage}
            onCloseButtonClick={this.handleCloseFilterError}
          >
            {url ? <Link href={url}>{urlMessage}</Link> : null}
          </ActionableNotification>
        )}

        <Form onSubmit={this.handleAddFilter} autoComplete="on">
          <Search
            placeholder={searchDescription}
            labelText={searchDescription}
            onChange={this.handleChange}
            value={currentFilterValue}
            name="filter-search"
            size="lg"
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                this.resetCurrentFilterValue();
                this.clearTextSearch();
              }
            }}
          />
          <Button type="submit" className="tkn--visually-hidden">
            {intl.formatMessage({
              id: 'dashboard.labelFilter.addFilterButton',
              defaultMessage: 'Add filter'
            })}
          </Button>
        </Form>

        <div className="tkn--filters">
          {filters.map(filter => (
            <Tag
              filter
              key={`label-${filter}`}
              onClick={() => this.props.handleDeleteFilter(filter)}
              onClose={() => this.props.handleDeleteFilter(filter)}
              type="high-contrast"
            >
              {filter.replace(/=/g, ':')}
            </Tag>
          ))}

          {textQuery ? (
            <Tag
              filter
              key="__text_query__"
              onClick={this.clearTextSearch}
              onClose={this.clearTextSearch}
              type="high-contrast"
            >
              {textQuery}
            </Tag>
          ) : null}

          {(filters.length > 0 || textQuery) && (
            <Button
              kind="ghost"
              size="sm"
              onClick={() => {
                this.props.handleClearFilters();
                this.clearTextSearch();
              }}
            >
              {intl.formatMessage({
                id: 'dashboard.labelFilter.clearAll',
                defaultMessage: 'Clear all'
              })}
            </Button>
          )}
        </div>
      </div>
    );
  }
}

LabelFilter.defaultProps = {
  filters: []
};

export default injectIntl(LabelFilter);
