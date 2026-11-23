(function () {
  'use strict';

  var hours = 5;
  var timer = null;

  function $(id) {
    return document.getElementById(id);
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function secs(ms) {
    return ms == null ? '-' : (ms / 1000).toFixed(1) + ' s';
  }

  function pct(v) {
    return v == null ? '-' : v + '%';
  }

  function fmtTime(iso) {
    if (!iso) return '-';
    var d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleString('zh-CN', {
      hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    });
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function renderKpis(data) {
    var c = data.cpa || {};
    var total = c.total || 0;
    var ok = c.ok || 0;
    var rate = total ? Math.round((ok / total) * 100) : 0;
    var lat = c.latency || {};
    var items = [
      { label: '请求总数', value: total, hint: (c.cancelled || 0) + (c.failed || 0) + ' 次未完成' },
      { label: '成功率', value: rate + '%', hint: ok + ' 成功 / ' + total },
      { label: '保存图片', value: (data.studio && data.studio.images) || 0, hint: 'Image Studio 落库' },
      {
        label: '平均延迟',
        value: lat.avg ? (lat.avg / 1000).toFixed(1) + ' s' : '-',
        hint: lat.p90 ? 'P90 ' + (lat.p90 / 1000).toFixed(1) + ' s' : '无样本'
      }
    ];
    var box = $('kpis');
    clear(box);
    items.forEach(function (item) {
      var card = el('div', 'card kpi');
      card.appendChild(el('div', 'label', item.label));
      card.appendChild(el('div', 'value', item.value));
      card.appendChild(el('div', 'hint', item.hint));
      box.appendChild(card);
    });
  }

  function renderChart(data) {
    var buckets = (data.cpa && data.cpa.hourly) || [];
    var chart = $('chart');
    var axis = $('axis');
    var hint = $('chartHint');
    clear(chart);
    clear(axis);
    if (!buckets.length) {
      chart.appendChild(el('div', 'empty', '没有数据'));
      hint.textContent = '';
      return;
    }
    var max = 1;
    buckets.forEach(function (b) {
      max = Math.max(max, b.ok + b.cancelled + b.failed);
    });
    buckets.forEach(function (b) {
      var total = b.ok + b.cancelled + b.failed;
      var bar = el('div', 'bar');
      bar.title = b.label + ' 成功 ' + b.ok + ' / 取消 ' + b.cancelled + ' / 失败 ' + b.failed;
      var height = total ? Math.max(4, Math.round((total / max) * 100)) : 0;
      [['ok', b.ok], ['cancelled', b.cancelled], ['failed', b.failed]].forEach(function (pair) {
        var n = pair[1];
        if (!n) return;
        var seg = el('div', 'seg ' + pair[0]);
        seg.style.setProperty('--h', (n / total) * height + '%');
        bar.appendChild(seg);
      });
      chart.appendChild(bar);
    });
    var step = Math.max(1, Math.ceil(buckets.length / 12));
    buckets.forEach(function (b, i) {
      axis.appendChild(el('span', null, i % step === 0 ? b.label : ''));
    });
    hint.textContent = '峰值 ' + max + ' 次/小时';
  }

  function renderAccounts(data) {
    var rows = (data.cpa && data.cpa.accounts) || [];
    var box = $('accounts');
    clear(box);
    if (!rows.length) {
      box.appendChild(el('div', 'empty', '没有请求'));
      return;
    }
    var table = el('table');
    var thead = el('thead');
    var hr = el('tr');
    ['账号', '成功', '取消', '失败'].forEach(function (label, i) {
      hr.appendChild(el('th', i ? 'num' : null, label));
    });
    thead.appendChild(hr);
    var tbody = el('tbody');
    rows.forEach(function (r) {
      var tr = el('tr');
      tr.appendChild(el('td', null, r.account));
      tr.appendChild(el('td', 'num', r.ok));
      tr.appendChild(el('td', 'num', r.cancelled || 0));
      tr.appendChild(el('td', 'num', r.failed));
      tbody.appendChild(tr);
    });
    table.appendChild(thead);
    table.appendChild(tbody);
    box.appendChild(table);
  }

  function quotaClass(p) {
    if (p == null) return 'muted';
    if (p <= 20) return 'err';
    if (p <= 50) return 'warn';
    return 'ok';
  }

  function windowLabel(label) {
    if (label === '5-hour limit') return '5 小时';
    if (label === 'Weekly limit') return '每周';
    return label || '';
  }

  function renderCodex(data) {
    var rows = data.codex || [];
    var box = $('codex');
    clear(box);
    if (!rows.length) {
      box.appendChild(el('div', 'empty', '没有 Codex 账号'));
      return;
    }
    var quota = el('div', 'quota');
    rows.forEach(function (acc) {
      var card = el('div', 'card');
      var head = el('div', 'q-head');
      head.appendChild(el('span', 'q-name', acc.account || 'Codex'));
      head.appendChild(el('span', 'q-plan', acc.plan || ''));
      card.appendChild(head);
      if (acc.error) {
        card.appendChild(el('div', 'err', acc.error));
        quota.appendChild(card);
        return;
      }
      (acc.windows || []).forEach(function (w) {
        var available = w.meterAvailable !== false;
        var row = el('div', 'q-row');
        var meta = el('div', 'q-meta');
        meta.appendChild(el('span', null, windowLabel(w.label)));
        meta.appendChild(el('span', null, available ? '剩余 ' + pct(w.remainingPercent) : '比例未回传'));
        row.appendChild(meta);
        var track = el('div', 'track');
        var fill = el('div', 'fill ' + (available ? quotaClass(w.remainingPercent) : 'muted'));
        var width = available
          ? (w.remainingPercent == null ? 0 : Math.max(2, w.remainingPercent))
          : 100;
        fill.style.setProperty('--w', width + '%');
        track.appendChild(fill);
        row.appendChild(track);
        var meta2 = el('div', 'q-meta');
        meta2.appendChild(el('span', null, '重置 ' + fmtTime(w.resetAt)));
        meta2.appendChild(el('span', null, available
          ? (w.windowSeconds ? w.windowSeconds / 3600 + 'h 窗口' : '')
          : ((w.usage && w.usage.tokens ? 'tokens ' + w.usage.tokens + ' · ' : '') + '仅显示限额')));
        row.appendChild(meta2);
        card.appendChild(row);
      });
      quota.appendChild(card);
    });
    box.appendChild(quota);
  }

  function renderStudio(data) {
    var s = data.studio || {};
    var jobs = s.jobs || {};
    var labels = {
      succeeded: '成功', cancelled: '取消', failed: '失败',
      queued: '排队', running: '生成中', timeout: '超时'
    };
    var chips = $('studioJobs');
    clear(chips);
    var any = false;
    Object.keys(labels).forEach(function (key) {
      if (!jobs[key]) return;
      any = true;
      chips.appendChild(el('span', 'chip', labels[key] + ' ' + jobs[key]));
    });
    if (!any) chips.appendChild(el('span', 'empty', '窗口内没有任务'));

    var users = s.users || [];
    var box = $('studioUsers');
    clear(box);
    if (!users.length) return;
    var table = el('table');
    var thead = el('thead');
    var hr = el('tr');
    ['用户', '状态', '数量'].forEach(function (label, i) {
      hr.appendChild(el('th', i === 2 ? 'num' : null, label));
    });
    thead.appendChild(hr);
    var tbody = el('tbody');
    users.forEach(function (u) {
      var tr = el('tr');
      tr.appendChild(el('td', null, u.user));
      tr.appendChild(el('td', null, labels[u.status] || u.status));
      tr.appendChild(el('td', 'num', u.n));
      tbody.appendChild(tr);
    });
    table.appendChild(thead);
    table.appendChild(tbody);
    box.appendChild(table);
  }

  function renderErrors(data) {
    var rows = (data.cpa && data.cpa.errors) || [];
    var box = $('errors');
    clear(box);
    if (!rows.length) {
      box.appendChild(el('div', 'empty', '没有失败'));
      return;
    }
    var list = el('ul', 'errlist');
    rows.forEach(function (e) {
      var li = el('li');
      li.appendChild(document.createTextNode(e.at + ' · ' + e.account + ' · ' + secs(e.latencyMs) + ' · '));
      li.appendChild(el('code', null, e.error));
      list.appendChild(li);
    });
    box.appendChild(list);
  }

  function render(data) {
    var w = data.window || {};
    $('windowLabel').textContent = '窗口 ' + (w.fromCst || '') + ' → ' + (w.toCst || '');
    renderKpis(data);
    renderChart(data);
    renderAccounts(data);
    renderCodex(data);
    renderStudio(data);
    renderErrors(data);
    var errs = [];
    if (data.cpa && data.cpa.error) errs.push('CPA: ' + data.cpa.error);
    if (data.studio && data.studio.error) errs.push('Studio: ' + data.studio.error);
    $('updated').textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) +
      (errs.length ? ' · ' + errs.join(' · ') : '');
  }

  function showMessage(title, text) {
    var box = $('kpis');
    clear(box);
    var card = el('div', 'card kpi');
    card.appendChild(el('div', 'label', title));
    card.appendChild(el('div', 'value', '—'));
    card.appendChild(el('div', 'hint', text));
    box.appendChild(card);
    $('updated').textContent = '';
  }

  async function load() {
    try {
      var res = await fetch('/api/admin/usage?hours=' + hours, { headers: { accept: 'application/json' } });
      if (res.status === 401 || res.status === 403) {
        showMessage('需要管理员登录', '请用管理员账号登录后再打开此页');
        return;
      }
      if (!res.ok) {
        showMessage('加载失败', 'HTTP ' + res.status);
        return;
      }
      render(await res.json());
    } catch (err) {
      showMessage('加载失败', String(err && err.message ? err.message : err));
    }
  }

  function schedule() {
    if (timer) clearInterval(timer);
    timer = setInterval(load, 60000);
  }

  document.querySelectorAll('[data-hours]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      hours = Number(btn.dataset.hours) || 5;
      document.querySelectorAll('[data-hours]').forEach(function (b) {
        b.classList.toggle('active', b === btn);
      });
      load();
      schedule();
    });
  });
  var refresh = $('refresh');
  if (refresh) refresh.addEventListener('click', load);

  load();
  schedule();
})();
