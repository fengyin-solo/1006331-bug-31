<template>
  <section class="page" data-module="dispatch">
    <header class="page-head">
      <div>
        <h2>派工清单（统一口径）</h2>
        <p class="page-desc">
          管廊停用、存量缺项核补、重复提交驳回都落在这一张清单；入廊管线、在册设备、环境监测、管廊台账各入口读到的是同一份。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="reload">刷新清单</button>
        <button class="btn ghost" type="button" @click="resetAllData">重置为示例数据并重跑存量补录</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>管廊编号</span>
        <input v-model="tunnelFilter" placeholder="按管廊编号检索" />
      </label>
      <label class="filter-item">
        <span>类型</span>
        <input v-model="typeFilter" placeholder="停用告知单 / 缺项核补单 / 重复提交驳回单" />
      </label>
      <button class="btn" type="submit">查询</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th>单号</th>
          <th>类型</th>
          <th>管廊</th>
          <th>涉及管线</th>
          <th>涉及设备</th>
          <th>涉及监测点</th>
          <th>业务发生日</th>
          <th>来源</th>
          <th>状态</th>
          <th>处理意见</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="order in filtered" :key="order.id">
          <td>#{{ order.id }}</td>
          <td><span :class="['badge', order.类型 === '停用告知单' ? 'stop' : order.类型 === '缺项核补单' ? 'repair' : 'idle']">{{ order.类型 }}</span></td>
          <td>{{ order.管廊编号 }}<br /><span class="page-desc">{{ order.管廊名称 }}</span></td>
          <td>{{ order.涉及管线.join('、') || '—' }}</td>
          <td>{{ order.涉及设备.join('、') || '—' }}</td>
          <td>{{ order.涉及监测点.join('、') || '—' }}</td>
          <td>{{ order.业务发生日 }}</td>
          <td>{{ order.来源 }}</td>
          <td><span :class="['badge', order.状态 === '待处理' ? 'repair' : 'run']">{{ order.状态 }}</span></td>
          <td style="max-width: 360px">
            <div class="opinion-box">{{ order.处理意见 }}</div>
          </td>
          <td>
            <button v-if="order.状态 === '待处理'" class="link" type="button" @click="resolve(order.id)">回写已处理</button>
            <span v-else class="page-desc">已回写</span>
          </td>
        </tr>
        <tr v-if="!filtered.length">
          <td colspan="11" class="empty-state">暂无派工单</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>处理意见全平台只存这一份：任何入口回写后，其余入口立即取到相同结果；同一单重复回写只认第一次。</span>
      <span v-if="message" :class="message.startsWith('已') ? 'stat-label' : 'error-text'">{{ message }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { listOrders, resetAll, resolveOrder } from '@/api/local-service'
import type { DispatchOrder } from '@/domain/types'

const orders = ref<DispatchOrder[]>([])
const tunnelFilter = ref('')
const typeFilter = ref('')
const message = ref('')

const filtered = computed(() =>
  orders.value.filter(
    (order) =>
      (!tunnelFilter.value || order.管廊编号.includes(tunnelFilter.value.trim())) &&
      (!typeFilter.value || order.类型.includes(typeFilter.value.trim())),
  ),
)

const stats = computed(() => [
  { label: '派工单总数', value: orders.value.length },
  { label: '停用告知单', value: orders.value.filter((order) => order.类型 === '停用告知单').length },
  { label: '缺项核补单', value: orders.value.filter((order) => order.类型 === '缺项核补单').length },
  { label: '重复提交驳回单', value: orders.value.filter((order) => order.类型 === '重复提交驳回单').length },
  { label: '待处理', value: orders.value.filter((order) => order.状态 === '待处理').length },
])

function resolve(id: number) {
  const result = resolveOrder(id)
  message.value = result.message
  reload()
}

function resetAllData() {
  resetAll()
  message.value = '已重置并按业务发生日重跑存量补录（同一管廊重复笔仍会被挡回）。'
  reload()
}

function reload() {
  orders.value = listOrders()
}

onMounted(reload)
</script>
