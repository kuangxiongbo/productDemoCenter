/**
 * Global Task Status Center
 */
const activeTasks = new Map();

/**
 * Serial Task Queue: Ensures only one high IO task runs at a time
 */
class PipelineQueue {
    constructor() {
        this.queue = [];
        this.processing = false;
    }

    /**
     * Add task to queue
     * @param {string} taskId 
     * @param {Function} taskFn (async)
     */
    add(taskId, taskFn) {
        return new Promise((resolve, reject) => {
            this.queue.push({ taskId, taskFn, resolve, reject });
            this.updateStatus(taskId, 'pending', '正在排队等待 IO 资源...');
            this.process();
        });
    }

    async process() {
        if (this.processing || this.queue.length === 0) return;
        this.processing = true;

        const { taskId, taskFn, resolve, reject } = this.queue.shift();
        console.log(`[Queue] 开始执行任务: ${taskId}`);

        try {
            const result = await taskFn();
            resolve(result);
        } catch (error) {
            reject(error);
        } finally {
            this.processing = false;
            console.log(`[Queue] 任务完成，尝试下一个...`);
            this.process();
        }
    }

    updateStatus(taskId, status, message, progress = null) {
        const task = activeTasks.get(taskId) || { steps: [] };
        task.status = status;
        if (message) task.lastMessage = message;
        if (progress !== null) task.progress = progress;
        
        // Mark all existing steps as 'done'
        task.steps.forEach(s => {
            if (s.status !== 'failed') s.status = 'done';
        });

        // Record new step
        if (message && (!task.steps.length || task.steps[task.steps.length - 1].message !== message)) {
            // New step is 'active' if task is overall processing/pending
            // If the task failed/succeeded, the last step will be handled accordingly
            const stepStatus = (status === 'success') ? 'done' : 
                             (status === 'failed') ? 'failed' : 'active';
            task.steps.push({ message, time: new Date(), status: stepStatus });
        } else if (task.steps.length > 0) {
            // Update status of matching last step if necessary
            const lastStep = task.steps[task.steps.length - 1];
            if (status === 'success') lastStep.status = 'done';
            if (status === 'failed') lastStep.status = 'failed';
        }
        
        activeTasks.set(taskId, task);
    }
}

const globalQueue = new PipelineQueue();

module.exports = {
    activeTasks,
    globalQueue,
    PipelineQueue
};
