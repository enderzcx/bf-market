import React, { useEffect, useState } from 'react';
import './lab.css';
import { fujiExplorerTx } from '../../helpers/format';
const nodes = [
  ['创建订单','10 USD · 比例锁定 10%','01'],
  ['钱包付款','x402 · 10 测试 USDC','02'],
  ['确认佣金','业务账本 · 1 测试 USDC','03'],
  ['伙伴到账','链上出款 · 账本完成','04'],
  ['锁定权益','本地已验证 · 待接入 Fuji','05'],
  ['自主领取','下一阶段 · 待接入验证','06'],
  ['更多商家','后续规划 · 生产验收','07'],
];
const roadmap = [
 ['佣金权利接入', '合约本地已验证', '固定受益人、金额和领取时间，预留最终确认佣金的资金。下一步接入 Fuji，验证停掉后台后仍可触发领取。'],
 ['new-api／sub2api 适配', '开发路线', '从指定版本建立兼容矩阵，验证订单、退款、去重与失败恢复。当前仅验证 BeefAPI 测试接入。'],
 ['结算 L1 原型', '开发路线', '探索让 L1 服务于佣金规则、资金权利与结算执行。费用、验证者、准入及调度方案后续单独设计。'],
 ['预制配置与专属部署', '开发路线', '计划提供可复用的 L1 配置包，按商家需求定制规则并协助部署。具体模板后续确定，尚未提供下载或部署服务。'],
 ['跨 L1 与协议优化', '后续研究', '通过 ICM／ICTT 接入其他 L1 的业务与资金，再按实测评估协议优化。'],
];
const variants = {rail:['A / 光轨','一条光轨，串起每笔到账。'],circuit:['B / 回路','让付款的每一步，都有回响。'],pulse:['C / 脉冲','从一次付款，到伙伴到账。']};
const incoming=fujiExplorerTx('0xd0df9f773a5d033e4ee0475a47cf48f54c653b778077662555e6c531d45104c6') + '#logs';
const outgoing=fujiExplorerTx('0x6f9843b7c2d14211c07ef6d539a625cd4c8b1c962426b49ada6b15ac8fdea23d');
export default function ProgressLab({preview=true}){
 const initial=new URLSearchParams(location.search).get('variant');
 const [variant,setVariant]=useState(preview ? (variants[initial]?initial:'rail') : 'pulse');
 const [running,setRunning]=useState(true);
 useEffect(()=>{document.title=preview?'进度动效方案 · 伙伴中心':'产品进展 · 伙伴中心';},[preview]);
 function choose(key){setVariant(key);history.replaceState(null,'',`?variant=${key}`);}
 return <main className={`chain-lab chain-${variant} ${preview?'':'chain-public'} ${running?'':'chain-paused'}`}>
  <header className='chain-top'><a href='/partner'>伙伴中心 <span>BF Labs</span></a><a href={preview?'/partner/progress':'/partner/docs'}>{preview?'查看产品进展 ↗':'使用说明 ↗'}</a></header>
  <div className='chain-controls' aria-label='动效方案'>{preview ? <div role='group' aria-label='选择方案'>{Object.entries(variants).map(([key,[name]])=><button key={key} aria-pressed={variant===key} onClick={()=>choose(key)}>{name}</button>)}</div> : <span className='chain-version'>产品进展 / Avalanche Fuji</span>}<button className='chain-toggle' onClick={()=>setRunning(!running)}>{running?'暂停动效':'播放动效'}</button></div>
  <section className='chain-story'><p className='chain-kicker'>BUILDING PARTNER CENTER / 产品进展</p><h1>{variants[variant][1]}</h1><p className='chain-intro'>商家确认佣金，伙伴核对到账。<br/>下一步，让佣金有资金保障。</p><div className='chain-legend'><span><i/>已验证 · Fuji</span><span><i/>开发与规划</span></div></section>
  <section className='chain-map' aria-label={preview?'付款到佣金到账及后续开发链路':'已验证的 Fuji 付款与返佣链路'} key={variant}>
    <svg className='chain-wires' viewBox='0 0 1000 450' preserveAspectRatio='none' aria-hidden='true'>
      <path className='wire-dim' d={variant==='circuit'?'M70 100 H970 V340 H70':'M60 200 H940'}/>
      <path className='wire-lit' d={variant==='circuit'?'M70 100 H820':'M60 200 H500'}/>
    </svg>
    <div className='chain-beam' aria-hidden='true'/>
    <ol>{(preview?nodes:nodes.slice(0,4)).map(([name,detail,number],i)=><li key={number} className={i<4?'chain-node is-done':'chain-node is-next'} style={{'--i':i}}>
      <div className='chain-junction' aria-hidden='true'><span/></div><span className='chain-step'>{number} / {i<4?'已验证':i===4?'本地验证':'待验证'}</span><h2>{name}</h2><p>{detail}</p>{i===1&&<a href={incoming} target='_blank' rel='noreferrer'>10 USDC 转账日志 ↗</a>}{i===3&&<a href={outgoing} target='_blank' rel='noreferrer'>到账凭证 ↗</a>}
    </li>)}</ol>
  </section>
  <footer className='chain-caption'><div><span>已完成案例 · 2026.09.18</span><p>10 测试 USDC 收款 → 10% 佣金 → 1 测试 USDC 到账</p></div><p>动画为历史流程示意，不发起付款。<br/>Avalanche Fuji 测试资金无实际价值。</p></footer>
  {!preview && <section className='chain-roadmap' aria-labelledby='roadmap-title'>
    <div className='chain-roadmap-heading'><p className='chain-kicker'>DEVELOPMENT / 开发路线</p><h2 id='roadmap-title'>让已确认的佣金，<br/>有资金保障。</h2><p>连接 API 服务商的业务与结算。<br/>以下能力尚未进入当前 Fuji 付款流程。</p></div>
    <ol>{roadmap.map(([title,status,detail],i)=><li key={title}><span className='chain-step'>{String(i+1).padStart(2,'0')} / {status}</span><h3>{title}</h3><p>{detail}</p></li>)}</ol>
    <div className='chain-roadmap-note'><h3>商家自部署，结算网络按需选择</h3><p>软件可接入已有链，专属 L1 是后续交付方向。配置包计划覆盖规则参数、费用与准入设置，并配套部署检查、备份及升级流程。验证者、资产路径和已登记佣金的领取保障需按部署方案明确。</p><h3>Agent 也能参与合作</h3><p>计划通过 MCP，让商家和伙伴自己的 Agent 查询收益、规则与回执，获取推广资料并辅助准备内容。发布需经授权，实际效果以业务数据核验。</p></div>
  </section>}
  {!preview && <section className='chain-about'><div><h2>成果，可以核对。</h2><p>10 测试 USDC 进入 Settlement 合约，业务系统按锁定的 10% 确认佣金，同一合约付出 1 测试 USDC，再回写账本。收款与返佣是两笔交易。当前为单商家测试环境。</p><a href='https://testnet.avascan.info/blockchain/c/address/0x5c905e43e0BB381534530d5e05DF56ab1f420899' target='_blank' rel='noreferrer'>查看当前 Fuji 结算合约 ↗</a></div><div><h2>商家自己的伙伴中心。</h2><p>优先服务 new-api、sub2api 部署者，通过适配器连接既有业务。欢迎参与版本适配、佣金权利验证与定制 L1 原型。</p><a href='/demo'>查看演示 ↗</a><a href='mailto:hello@bflabs.cn'>联系 BF Labs ↗</a><a href='https://github.com/enderzcx/partner-center' target='_blank' rel='noreferrer'>查看开源代码 ↗</a></div></section>}
 </main>
}
