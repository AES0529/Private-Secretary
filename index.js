// 私人秘书 - SillyTavern Extension
// 扩展入口文件

const MODULE_NAME = "private-secretary";

// 任务优先级类型
const PRIORITY = {
  URGENT_IMPORTANT: "urgent-important",
  NOT_URGENT_IMPORTANT: "not-urgent-important",
  URGENT_NOT_IMPORTANT: "urgent-not-important",
  NOT_URGENT_NOT_IMPORTANT: "not-urgent-not-important",
};

const PRIORITY_LABELS = {
  [PRIORITY.URGENT_IMPORTANT]: "重要且紧急",
  [PRIORITY.NOT_URGENT_IMPORTANT]: "重要不紧急",
  [PRIORITY.URGENT_NOT_IMPORTANT]: "不重要但紧急",
  [PRIORITY.NOT_URGENT_NOT_IMPORTANT]: "不重要不紧急",
};

// TickTick 优先级映射 (0: none, 1: low, 3: medium, 5: high)
const TICKTICK_PRIORITY_MAP = {
  [PRIORITY.URGENT_IMPORTANT]: 5,
  [PRIORITY.NOT_URGENT_IMPORTANT]: 3,
  [PRIORITY.URGENT_NOT_IMPORTANT]: 3,
  [PRIORITY.NOT_URGENT_NOT_IMPORTANT]: 1,
};

// 默认设置
const defaultSettings = Object.freeze({
  enabled: true,
  tasks: [],
  ticktickToken: "",
});

// 当前视图状态（延迟初始化 selectedDate）
let viewState = {
  year: new Date().getFullYear(),
  month: new Date().getMonth(),
  selectedDate: null,
};

// 获取或初始化设置
function getSettings() {
  const { extensionSettings } = SillyTavern.getContext();
  if (!extensionSettings[MODULE_NAME]) {
    extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
  }
  // 确保 tasks 数组存在
  if (!Array.isArray(extensionSettings[MODULE_NAME].tasks)) {
    extensionSettings[MODULE_NAME].tasks = [];
  }
  return extensionSettings[MODULE_NAME];
}

// 保存设置
function saveSettings() {
  const { saveSettingsDebounced } = SillyTavern.getContext();
  saveSettingsDebounced();
}

// 生成唯一ID
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2);
}

// 添加任务
function addTask(title, date, time, endTime, priority) {
  const settings = getSettings();
  const task = {
    id: generateId(),
    title,
    date,
    time,
    endTime: endTime || null, // 结束时间，null 表示单一时间点任务
    priority,
    completed: false,
    createdAt: new Date().toISOString(),
  };
  settings.tasks.push(task);
  saveSettings();
  return task;
}

// 删除任务
function deleteTask(taskId) {
  const settings = getSettings();
  settings.tasks = settings.tasks.filter((t) => t.id !== taskId);
  saveSettings();
}

// 切换任务完成状态
function toggleTaskComplete(taskId) {
  const settings = getSettings();
  const task = settings.tasks.find((t) => t.id === taskId);
  if (task) {
    task.completed = !task.completed;
    saveSettings();
  }
}

// 编辑任务
function editTask(taskId, updates) {
  const settings = getSettings();
  const task = settings.tasks.find((t) => t.id === taskId);
  if (!task) return false;

  Object.assign(task, updates);
  task.syncedToTickTick = false; // 编辑后重置同步状态
  saveSettings();
  return true;
}

// 清理过期任务（7天前的任务）
function cleanupExpiredTasks() {
  const settings = getSettings();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const cutoffDate = new Date(today);
  cutoffDate.setDate(cutoffDate.getDate() - 7);
  const cutoffStr = getDateString(cutoffDate);

  const originalCount = settings.tasks.length;
  settings.tasks = settings.tasks.filter((t) => t.date >= cutoffStr);
  const deletedCount = originalCount - settings.tasks.length;

  if (deletedCount > 0) {
    saveSettings();
    console.log(`[私人秘书] 自动清理了 ${deletedCount} 个过期任务`);
  }

  return deletedCount;
}

// 获取指定日期的任务
function getTasksByDate(dateStr) {
  const settings = getSettings();
  return settings.tasks.filter((t) => t.date === dateStr);
}

// 获取/设置 TickTick Token
function getTickTickToken() {
  return getSettings().ticktickToken || "";
}

function setTickTickToken(token) {
  const settings = getSettings();
  settings.ticktickToken = token;
  saveSettings();
}

// 将本地任务转换为 TickTick API 格式
function convertToTickTickTask(task) {
  const startDate = new Date(`${task.date}T${task.time}:00`);
  const tickTask = {
    title: task.title,
    startDate: startDate.toISOString(),
    priority: TICKTICK_PRIORITY_MAP[task.priority] || 0,
    isAllDay: false,
  };

  // 如果有结束时间，设置 dueDate
  if (task.endTime) {
    const dueDate = new Date(`${task.date}T${task.endTime}:00`);
    tickTask.dueDate = dueDate.toISOString();
  }

  return tickTask;
}

// 发送任务到 TickTick
async function sendTaskToTickTick(task) {
  const token = getTickTickToken();
  if (!token) {
    throw new Error("请先设置 TickTick Access Token");
  }

  const tickTask = convertToTickTickTask(task);

  const response = await fetch("https://api.ticktick.com/open/v1/task", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(tickTask),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`TickTick API 错误: ${response.status} - ${errorText}`);
  }

  return await response.json();
}

// 同步当天所有未完成任务到 TickTick
async function syncDayTasksToTickTick(dateStr) {
  const tasks = getTasksByDate(dateStr).filter(
    (t) => !t.completed && !t.syncedToTickTick
  );

  if (tasks.length === 0) {
    return { success: 0, failed: 0, message: "没有需要同步的任务" };
  }

  let success = 0;
  let failed = 0;
  const errors = [];

  for (const task of tasks) {
    try {
      await sendTaskToTickTick(task);
      // 标记已同步
      task.syncedToTickTick = true;
      success++;
    } catch (error) {
      failed++;
      errors.push(`${task.title}: ${error.message}`);
    }
  }

  saveSettings();

  return {
    success,
    failed,
    message: errors.length > 0 ? errors.join("\n") : "全部同步成功",
  };
}

// 格式化日期显示
function formatDate(date) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const weekDays = ["日", "一", "二", "三", "四", "五", "六"];
  const weekDay = weekDays[date.getDay()];
  return `${year}年${month}月${day}日 星期${weekDay}`;
}

// 获取日期字符串 YYYY-MM-DD
function getDateString(date) {
  return date.toISOString().split("T")[0];
}

// 渲染日历
function renderCalendar(year, month) {
  const settings = getSettings();
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const startWeekDay = firstDay.getDay();
  const totalDays = lastDay.getDate();

  let html = '<div class="ps-calendar-grid">';
  html += '<div class="ps-calendar-header">日</div>';
  html += '<div class="ps-calendar-header">一</div>';
  html += '<div class="ps-calendar-header">二</div>';
  html += '<div class="ps-calendar-header">三</div>';
  html += '<div class="ps-calendar-header">四</div>';
  html += '<div class="ps-calendar-header">五</div>';
  html += '<div class="ps-calendar-header">六</div>';

  for (let i = 0; i < startWeekDay; i++) {
    html += '<div class="ps-calendar-day empty"></div>';
  }

  const today = getDateString(new Date());

  for (let day = 1; day <= totalDays; day++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(
      day
    ).padStart(2, "0")}`;
    const dayTasks = settings.tasks.filter((t) => t.date === dateStr);
    const isToday = dateStr === today;
    const hasTask = dayTasks.length > 0;

    let taskDots = "";
    if (hasTask) {
      const priorities = [...new Set(dayTasks.map((t) => t.priority))];
      taskDots =
        '<div class="ps-task-dots">' +
        priorities.map((p) => `<span class="ps-dot ${p}"></span>`).join("") +
        "</div>";
    }

    html += `<div class="ps-calendar-day${isToday ? " today" : ""}${
      hasTask ? " has-task" : ""
    }" data-date="${dateStr}">
      <span class="ps-day-number">${day}</span>
      ${taskDots}
    </div>`;
  }

  html += "</div>";
  return html;
}

// 格式化任务时间显示
function formatTaskTime(task) {
  if (task.endTime) {
    return `${task.time} - ${task.endTime}`;
  }
  return task.time;
}

// 渲染任务编辑表单
function renderEditForm(task) {
  return `
    <div class="ps-task-item editing" data-id="${task.id}">
      <div class="ps-edit-form">
        <input type="text" class="ps-edit-title" value="${
          task.title
        }" placeholder="任务标题" />
        <div class="ps-edit-row">
          <input type="date" class="ps-edit-date" value="${task.date}" />
        </div>
        <div class="ps-edit-row">
          <input type="time" class="ps-edit-time" value="${
            task.time
          }" title="开始时间" />
          <span class="ps-time-separator">-</span>
          <input type="time" class="ps-edit-end-time" value="${
            task.endTime || ""
          }" title="结束时间（可选）" />
        </div>
        <div class="ps-edit-row">
          <select class="ps-edit-priority">
            <option value="${PRIORITY.URGENT_IMPORTANT}"${
    task.priority === PRIORITY.URGENT_IMPORTANT ? " selected" : ""
  }>🔴 重要且紧急</option>
            <option value="${PRIORITY.NOT_URGENT_IMPORTANT}"${
    task.priority === PRIORITY.NOT_URGENT_IMPORTANT ? " selected" : ""
  }>🟡 重要不紧急</option>
            <option value="${PRIORITY.URGENT_NOT_IMPORTANT}"${
    task.priority === PRIORITY.URGENT_NOT_IMPORTANT ? " selected" : ""
  }>🔵 不重要但紧急</option>
            <option value="${PRIORITY.NOT_URGENT_NOT_IMPORTANT}"${
    task.priority === PRIORITY.NOT_URGENT_NOT_IMPORTANT ? " selected" : ""
  }>🟢 不重要不紧急</option>
          </select>
        </div>
        <div class="ps-edit-actions">
          <button class="ps-btn-save"><i class="fa-solid fa-check"></i> 保存</button>
          <button class="ps-btn-cancel"><i class="fa-solid fa-xmark"></i> 取消</button>
        </div>
      </div>
    </div>
  `;
}

// 渲染任务列表
function renderTaskList(dateStr) {
  const tasks = getTasksByDate(dateStr);

  if (tasks.length === 0) {
    return '<div class="ps-no-tasks">暂无任务安排</div>';
  }

  tasks.sort((a, b) => a.time.localeCompare(b.time));

  let html = '<div class="ps-task-list">';
  tasks.forEach((task) => {
    const timeDisplay = formatTaskTime(task);
    const isDuration = task.endTime ? " duration" : "";
    const syncedBadge = task.syncedToTickTick
      ? '<span class="ps-synced-badge" title="已同步到 TickTick"><i class="fa-solid fa-cloud-check"></i></span>'
      : "";
    html += `
      <div class="ps-task-item ${task.priority}${
      task.completed ? " completed" : ""
    }${isDuration}${task.syncedToTickTick ? " synced" : ""}" data-id="${
      task.id
    }">
        <div class="ps-task-checkbox">
          <input type="checkbox" ${task.completed ? "checked" : ""} />
        </div>
        <div class="ps-task-content">
          <div class="ps-task-title">${task.title} ${syncedBadge}</div>
          <div class="ps-task-meta">
            <span class="ps-task-time"><i class="fa-regular fa-clock"></i> ${timeDisplay}</span>
            <span class="ps-task-priority-label">${
              PRIORITY_LABELS[task.priority]
            }</span>
          </div>
        </div>
        <div class="ps-task-actions">
          <button class="ps-btn-edit" title="编辑"><i class="fa-solid fa-pen"></i></button>
          <button class="ps-btn-delete" title="删除"><i class="fa-solid fa-trash"></i></button>
        </div>
      </div>
    `;
  });
  html += "</div>";
  return html;
}

// 渲染主界面
function renderMainUI() {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();
  const todayStr = getDateString(now);
  const savedToken = getTickTickToken();

  return `
    <div id="ps-container">
      <div class="ps-header">
        <h3><i class="fa-solid fa-calendar-check"></i> 私人秘书 - 日程管理</h3>
      </div>
      <div class="ps-ticktick-section">
        <div class="ps-ticktick-header">
          <i class="fa-solid fa-cloud"></i> TickTick 同步设置
        </div>
        <div class="ps-token-row">
          <input type="password" id="ps-ticktick-token" placeholder="输入 Access Token..." value="${savedToken}" />
          <button id="ps-toggle-token" class="ps-btn-icon" title="显示/隐藏">
            <i class="fa-solid fa-eye"></i>
          </button>
          <button id="ps-save-token" class="ps-btn-secondary">
            <i class="fa-solid fa-save"></i> 保存
          </button>
        </div>
        <div class="ps-sync-row">
          <button id="ps-sync-day" class="ps-btn-sync">
            <i class="fa-solid fa-cloud-arrow-up"></i> 同步当天任务到 TickTick
          </button>
          <span id="ps-sync-status" class="ps-sync-status"></span>
        </div>
      </div>
      <div class="ps-cleanup-section">
        <button id="ps-cleanup-btn" class="ps-btn-cleanup">
          <i class="fa-solid fa-broom"></i> 一键清理过往任务
        </button>
        <span id="ps-cleanup-status" class="ps-cleanup-status"></span>
      </div>
      <div class="ps-main">
        <div class="ps-calendar-section">
          <div class="ps-calendar-nav">
            <button id="ps-prev-month" class="ps-nav-btn"><i class="fa-solid fa-chevron-left"></i></button>
            <span id="ps-current-month">${currentYear}年${
    currentMonth + 1
  }月</span>
            <button id="ps-next-month" class="ps-nav-btn"><i class="fa-solid fa-chevron-right"></i></button>
          </div>
          <div id="ps-calendar-container">
            ${renderCalendar(currentYear, currentMonth)}
          </div>
        </div>
        <div class="ps-task-section">
          <div class="ps-selected-date">
            <span id="ps-date-display">${formatDate(now)}</span>
          </div>
          <div class="ps-add-task-form">
            <input type="text" id="ps-task-title" placeholder="输入任务内容..." />
            <div class="ps-form-row">
              <input type="date" id="ps-task-date" value="${todayStr}" />
            </div>
            <div class="ps-form-row ps-time-row">
              <input type="time" id="ps-task-time" value="09:00" title="开始时间" />
              <span class="ps-time-separator">-</span>
              <input type="time" id="ps-task-end-time" placeholder="结束时间" title="结束时间（可选，留空表示单一时间点）" />
            </div>
            <div class="ps-form-row">
              <select id="ps-task-priority">
                <option value="${
                  PRIORITY.URGENT_IMPORTANT
                }">🔴 重要且紧急</option>
                <option value="${
                  PRIORITY.NOT_URGENT_IMPORTANT
                }">🟡 重要不紧急</option>
                <option value="${
                  PRIORITY.URGENT_NOT_IMPORTANT
                }">🔵 不重要但紧急</option>
                <option value="${
                  PRIORITY.NOT_URGENT_NOT_IMPORTANT
                }">🟢 不重要不紧急</option>
              </select>
              <button id="ps-add-task-btn" class="ps-btn-primary">
                <i class="fa-solid fa-plus"></i> 添加
              </button>
            </div>
          </div>
          <div id="ps-task-container">
            ${renderTaskList(todayStr)}
          </div>
          <div class="ps-legend">
            <span class="ps-legend-item"><span class="ps-dot urgent-important"></span> 重要且紧急</span>
            <span class="ps-legend-item"><span class="ps-dot not-urgent-important"></span> 重要不紧急</span>
            <span class="ps-legend-item"><span class="ps-dot urgent-not-important"></span> 不重要但紧急</span>
            <span class="ps-legend-item"><span class="ps-dot not-urgent-not-important"></span> 不重要不紧急</span>
          </div>
        </div>
      </div>
    </div>
  `;
}

// 更新日历视图
function updateCalendarView() {
  $("#ps-current-month").text(`${viewState.year}年${viewState.month + 1}月`);
  $("#ps-calendar-container").html(
    renderCalendar(viewState.year, viewState.month)
  );
  bindCalendarEvents();
}

// 更新任务列表视图
function updateTaskListView() {
  const date = new Date(viewState.selectedDate);
  $("#ps-date-display").text(formatDate(date));
  $("#ps-task-date").val(viewState.selectedDate);
  $("#ps-task-container").html(renderTaskList(viewState.selectedDate));
  bindTaskEvents();
}

// 绑定日历事件
function bindCalendarEvents() {
  $(".ps-calendar-day:not(.empty)")
    .off("click")
    .on("click", function () {
      const dateStr = $(this).data("date");
      viewState.selectedDate = dateStr;
      $(".ps-calendar-day").removeClass("selected");
      $(this).addClass("selected");
      updateTaskListView();
    });
}

// 检查是否有任务正在编辑中
function isEditingTask() {
  return $(".ps-task-item.editing").length > 0;
}

// 绑定编辑表单事件
function bindEditFormEvents(taskItem, originalHtml) {
  const taskId = taskItem.data("id");

  // 保存按钮事件
  taskItem.find(".ps-btn-save").on("click", function () {
    const title = taskItem.find(".ps-edit-title").val().trim();
    const date = taskItem.find(".ps-edit-date").val();
    const time = taskItem.find(".ps-edit-time").val();
    const endTime = taskItem.find(".ps-edit-end-time").val();
    const priority = taskItem.find(".ps-edit-priority").val();

    // 验证标题不能为空
    if (!title) {
      alert("任务标题不能为空");
      return;
    }

    // 验证结束时间必须晚于开始时间
    if (endTime && endTime <= time) {
      alert("结束时间必须晚于开始时间");
      return;
    }

    // 保存更新
    const updates = {
      title,
      date,
      time,
      endTime: endTime || null,
      priority,
    };

    if (editTask(taskId, updates)) {
      updateCalendarView();
      updateTaskListView();
    }
  });

  // 取消按钮事件
  taskItem.find(".ps-btn-cancel").on("click", function () {
    // 恢复原始显示
    taskItem.replaceWith(originalHtml);
    bindTaskEvents();
  });
}

// 绑定任务事件
function bindTaskEvents() {
  // 复选框事件 - 编辑模式下禁用
  $('.ps-task-item:not(.editing) input[type="checkbox"]')
    .off("change")
    .on("change", function () {
      if (isEditingTask()) {
        $(this).prop("checked", !$(this).prop("checked"));
        return;
      }
      const taskId = $(this).closest(".ps-task-item").data("id");
      toggleTaskComplete(taskId);
      updateCalendarView();
      updateTaskListView();
    });

  // 删除按钮事件 - 编辑模式下禁用
  $(".ps-task-item:not(.editing) .ps-btn-delete")
    .off("click")
    .on("click", function () {
      if (isEditingTask()) {
        return;
      }
      const taskId = $(this).closest(".ps-task-item").data("id");
      if (confirm("确定要删除这个任务吗？")) {
        deleteTask(taskId);
        updateCalendarView();
        updateTaskListView();
      }
    });

  // 编辑按钮事件
  $(".ps-task-item:not(.editing) .ps-btn-edit")
    .off("click")
    .on("click", function () {
      // 如果已有任务在编辑中，不允许编辑其他任务
      if (isEditingTask()) {
        alert("请先完成当前任务的编辑");
        return;
      }

      const taskItem = $(this).closest(".ps-task-item");
      const taskId = taskItem.data("id");
      const originalHtml = taskItem.clone();

      // 获取任务数据
      const settings = getSettings();
      const task = settings.tasks.find((t) => t.id === taskId);

      if (!task) {
        updateTaskListView();
        return;
      }

      // 替换为编辑表单
      const editFormHtml = renderEditForm(task);
      taskItem.replaceWith(editFormHtml);

      // 绑定编辑表单事件
      const newTaskItem = $(`.ps-task-item[data-id="${taskId}"]`);
      bindEditFormEvents(newTaskItem, originalHtml);
    });
}

// 初始化扩展 UI
function initExtension() {
  console.log("[私人秘书] initExtension 被调用");

  // 防止重复初始化
  if (document.getElementById("private_secretary_settings")) {
    console.log("[私人秘书] 扩展已存在，跳过初始化");
    return;
  }

  // 自动清理过期任务
  const deletedCount = cleanupExpiredTasks();
  if (deletedCount > 0) {
    console.log(`[私人秘书] 启动时清理了 ${deletedCount} 个过期任务`);
  }

  // 初始化 selectedDate
  viewState.selectedDate = getDateString(new Date());

  const settingsHtml = `
    <div id="private_secretary_settings" class="extension_settings">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b><i class="fa-solid fa-user-tie"></i> 私人秘书</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
          ${renderMainUI()}
        </div>
      </div>
    </div>
  `;

  $("#extensions_settings2").append(settingsHtml);

  // 阻止 SillyTavern 默认的双击事件，使用单击展开
  const $toggle = $("#private_secretary_settings .inline-drawer-toggle");

  // 移除可能存在的其他事件处理器
  $toggle.off("click dblclick");

  // 绑定单击事件
  $toggle.on("click", function (e) {
    e.stopPropagation();
    e.stopImmediatePropagation();
    const icon = $(this).find(".inline-drawer-icon");
    const content = $(this).next(".inline-drawer-content");
    icon.toggleClass("down");
    content.slideToggle();
  });

  // 阻止双击事件冒泡
  $toggle.on("dblclick", function (e) {
    e.stopPropagation();
    e.stopImmediatePropagation();
    e.preventDefault();
  });

  $("#ps-prev-month").on("click", function () {
    viewState.month--;
    if (viewState.month < 0) {
      viewState.month = 11;
      viewState.year--;
    }
    updateCalendarView();
  });

  $("#ps-next-month").on("click", function () {
    viewState.month++;
    if (viewState.month > 11) {
      viewState.month = 0;
      viewState.year++;
    }
    updateCalendarView();
  });

  $("#ps-add-task-btn").on("click", function () {
    const title = $("#ps-task-title").val().trim();
    const date = $("#ps-task-date").val();
    const time = $("#ps-task-time").val();
    const endTime = $("#ps-task-end-time").val();
    const priority = $("#ps-task-priority").val();

    if (!title) {
      alert("请输入任务内容");
      return;
    }

    // 验证结束时间必须晚于开始时间
    if (endTime && endTime <= time) {
      alert("结束时间必须晚于开始时间");
      return;
    }

    addTask(title, date, time, endTime, priority);
    $("#ps-task-title").val("");
    $("#ps-task-end-time").val("");

    if (date === viewState.selectedDate) {
      updateTaskListView();
    }
    updateCalendarView();
  });

  $("#ps-task-title").on("keypress", function (e) {
    if (e.which === 13) {
      $("#ps-add-task-btn").click();
    }
  });

  // TickTick Token 相关事件
  $("#ps-toggle-token").on("click", function () {
    const input = $("#ps-ticktick-token");
    const icon = $(this).find("i");
    if (input.attr("type") === "password") {
      input.attr("type", "text");
      icon.removeClass("fa-eye").addClass("fa-eye-slash");
    } else {
      input.attr("type", "password");
      icon.removeClass("fa-eye-slash").addClass("fa-eye");
    }
  });

  $("#ps-save-token").on("click", function () {
    const token = $("#ps-ticktick-token").val().trim();
    setTickTickToken(token);
    $("#ps-sync-status")
      .text("Token 已保存")
      .removeClass("error")
      .addClass("success");
    setTimeout(() => $("#ps-sync-status").text(""), 2000);
  });

  $("#ps-sync-day").on("click", async function () {
    const btn = $(this);
    const status = $("#ps-sync-status");

    if (!getTickTickToken()) {
      status
        .text("请先设置 Access Token")
        .removeClass("success")
        .addClass("error");
      return;
    }

    btn
      .prop("disabled", true)
      .find("i")
      .removeClass("fa-cloud-arrow-up")
      .addClass("fa-spinner fa-spin");
    status.text("同步中...").removeClass("error success");

    try {
      const result = await syncDayTasksToTickTick(viewState.selectedDate);
      if (result.failed === 0) {
        status
          .text(`✓ 成功同步 ${result.success} 个任务`)
          .removeClass("error")
          .addClass("success");
      } else {
        status
          .text(`同步完成: ${result.success} 成功, ${result.failed} 失败`)
          .removeClass("success")
          .addClass("error");
        console.error("[私人秘书] 同步错误:", result.message);
      }
      updateTaskListView();
    } catch (error) {
      status
        .text(`同步失败: ${error.message}`)
        .removeClass("success")
        .addClass("error");
      console.error("[私人秘书] 同步错误:", error);
    } finally {
      btn
        .prop("disabled", false)
        .find("i")
        .removeClass("fa-spinner fa-spin")
        .addClass("fa-cloud-arrow-up");
    }
  });

  // 手动清理过期任务按钮事件
  $("#ps-cleanup-btn").on("click", function () {
    const status = $("#ps-cleanup-status");

    if (!confirm("确定要清理7天前的所有任务吗？此操作不可撤销。")) {
      return;
    }

    const deletedCount = cleanupExpiredTasks();

    if (deletedCount > 0) {
      status
        .text(`✓ 已清理 ${deletedCount} 个过期任务`)
        .removeClass("error")
        .addClass("success");
      updateCalendarView();
      updateTaskListView();
    } else {
      status.text("没有需要清理的任务").removeClass("success error");
    }

    // 3秒后清除状态消息
    setTimeout(() => status.text(""), 3000);
  });

  bindCalendarEvents();
  bindTaskEvents();

  console.log("[私人秘书] 扩展已加载");
}

// 初始化入口 - 扩展加载时应用已经 ready，直接初始化
jQuery(() => {
  console.log("[私人秘书] jQuery ready，开始初始化");
  initExtension();
});
